package main

import (
	"database/sql"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	_ "github.com/lib/pq"
)

var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

type Message struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	To        string `json:"to,omitempty"`
	Text      string `json:"text"`
	IsFile    bool   `json:"isFile,omitempty"`
	FileUrl   string `json:"fileUrl,omitempty"`
	FileName  string `json:"fileName,omitempty"`
	Type      string `json:"type"`
	Timestamp int64  `json:"timestamp"`
	FileData  []byte `json:"-"` // не передаём по JSON
}

type Client struct {
	conn     *websocket.Conn
	username string
}

var (
	clients   = make(map[*Client]bool)
	mu        sync.Mutex
	broadcast = make(chan Message)
	db        *sql.DB
)

func initDB() {
	connStr := os.Getenv("DATABASE_URL") // Render даст эту переменную
	if connStr == "" {
		log.Fatal("DATABASE_URL is not set")
	}
	var err error
	db, err = sql.Open("postgres", connStr)
	if err != nil {
		log.Fatal("Failed to connect to DB:", err)
	}
	// Создаём таблицы
	createTables := `
    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        username TEXT,
        to_username TEXT,
        text TEXT,
        is_file BOOLEAN,
        file_name TEXT,
        file_data BYTEA,
        type TEXT,
        timestamp BIGINT
    );
    `
	_, err = db.Exec(createTables)
	if err != nil {
		log.Fatal("Failed to create tables:", err)
	}
}

func loadHistoryFromDB() []Message {
	rows, err := db.Query("SELECT id, username, to_username, text, is_file, file_name, type, timestamp FROM messages ORDER BY timestamp ASC")
	if err != nil {
		log.Println("loadHistory error:", err)
		return nil
	}
	defer rows.Close()
	var history []Message
	for rows.Next() {
		var m Message
		var toPtr sql.NullString
		err := rows.Scan(&m.ID, &m.Username, &toPtr, &m.Text, &m.IsFile, &m.FileName, &m.Type, &m.Timestamp)
		if err != nil {
			log.Println("scan error:", err)
			continue
		}
		if toPtr.Valid {
			m.To = toPtr.String
		}
		if m.IsFile {
			// Формируем URL для скачивания файла, который будет через отдельный хендлер
			m.FileUrl = "/api/file/" + m.ID
		}
		history = append(history, m)
	}
	return history
}

func saveMessageToDB(m Message) error {
	_, err := db.Exec(`
        INSERT INTO messages(id, username, to_username, text, is_file, file_name, file_data, type, timestamp)
        VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		m.ID, m.Username, m.To, m.Text, m.IsFile, m.FileName, m.FileData, m.Type, m.Timestamp)
	return err
}

func deleteMessageFromDB(id string) error {
	_, err := db.Exec("DELETE FROM messages WHERE id = $1", id)
	return err
}

func getFileData(id string) ([]byte, string, error) {
	var data []byte
	var fileName string
	err := db.QueryRow("SELECT file_data, file_name FROM messages WHERE id = $1", id).Scan(&data, &fileName)
	if err != nil {
		return nil, "", err
	}
	return data, fileName, nil
}

func main() {
	initDB()
	defer db.Close()

	go handleMessages()

	http.HandleFunc("/ws", wsHandler)
	http.HandleFunc("/upload", uploadHandler)
	http.HandleFunc("/api/file/", fileHandler) // для скачивания по ID

	staticDir := "dist"
	http.Handle("/", http.FileServer(http.Dir(staticDir)))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("Server started on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println(err)
		return
	}
	defer conn.Close()

	var initMsg Message
	err = conn.ReadJSON(&initMsg)
	if err != nil || initMsg.Type != "hello" || initMsg.Username == "" {
		conn.WriteJSON(Message{Type: "error", Text: "Invalid hello"})
		return
	}

	client := &Client{conn: conn, username: initMsg.Username}
	mu.Lock()
	clients[client] = true
	mu.Unlock()
	broadcastUserList()

	// Отправляем историю
	history := loadHistoryFromDB()
	for _, h := range history {
		conn.WriteJSON(h)
	}

	for {
		var incoming Message
		err := conn.ReadJSON(&incoming)
		if err != nil {
			mu.Lock()
			delete(clients, client)
			mu.Unlock()
			broadcastUserList()
			break
		}
		incoming.Username = client.username
		if incoming.Type == "" {
			incoming.Type = "msg"
		}
		if incoming.ID == "" {
			incoming.ID = uuid.New().String()
		}
		if incoming.Timestamp == 0 {
			incoming.Timestamp = time.Now().Unix()
		}

		if incoming.Type != "delete" {
			if err := saveMessageToDB(incoming); err != nil {
				log.Println("Failed to save message to DB:", err)
			}
		}
		broadcast <- incoming
	}
}

func broadcastUserList() {
	mu.Lock()
	userList := []string{}
	for c := range clients {
		userList = append(userList, c.username)
	}
	mu.Unlock()
	msg := Message{Type: "userList", Text: strings.Join(userList, ",")}
	for client := range clients {
		client.conn.WriteJSON(msg)
	}
}

func handleMessages() {
	for {
		msg := <-broadcast
		if msg.Type == "delete" {
			// проверка авторства
			var author string
			err := db.QueryRow("SELECT username FROM messages WHERE id = $1", msg.ID).Scan(&author)
			if err == nil && author == msg.Username {
				deleteMessageFromDB(msg.ID)
				for client := range clients {
					client.conn.WriteJSON(Message{Type: "delete", ID: msg.ID})
				}
			} else {
				log.Println("Unauthorized delete attempt by", msg.Username)
			}
			continue
		}

		mu.Lock()
		if msg.To == "" {
			for client := range clients {
				client.conn.WriteJSON(msg)
			}
		} else {
			for client := range clients {
				if client.username == msg.To || client.username == msg.Username {
					client.conn.WriteJSON(msg)
				}
			}
		}
		mu.Unlock()
	}
}

func uploadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	err := r.ParseMultipartForm(10 << 20) // 10 MB
	if err != nil {
		http.Error(w, "Failed to parse form", http.StatusBadRequest)
		return
	}
	file, handler, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "File error", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Читаем файл в память
	fileData, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "Failed to read file", http.StatusInternalServerError)
		return
	}

	// Создаём сообщение-заглушку для файла (будет сохранено в БД)
	fileMsg := Message{
		ID:        uuid.New().String(),
		Text:      handler.Filename,
		IsFile:    true,
		FileName:  handler.Filename,
		FileData:  fileData,
		Type:      "msg",
		Timestamp: time.Now().Unix(),
	}
	// Сохраняем в БД
	if err := saveMessageToDB(fileMsg); err != nil {
		log.Println("Failed to save file message:", err)
		http.Error(w, "DB error", http.StatusInternalServerError)
		return
	}

	// Отправляем ссылку на файл обратно клиенту
	w.Write([]byte("/api/file/" + fileMsg.ID))
}

func fileHandler(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/file/")
	if id == "" {
		http.Error(w, "Missing file ID", http.StatusBadRequest)
		return
	}
	data, fileName, err := getFileData(id)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Определяем Content-Type по расширению файла
	ext := strings.ToLower(filepath.Ext(fileName))
	var contentType string
	switch ext {
	case ".jpg", ".jpeg":
		contentType = "image/jpeg"
	case ".png":
		contentType = "image/png"
	case ".gif":
		contentType = "image/gif"
	case ".webp":
		contentType = "image/webp"
	case ".svg":
		contentType = "image/svg+xml"
	default:
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)

	// Для изображений показываем inline, для остальных - attachment
	if strings.HasPrefix(contentType, "image/") {
		w.Header().Set("Content-Disposition", "inline; filename="+fileName)
	} else {
		w.Header().Set("Content-Disposition", "attachment; filename="+fileName)
	}
	w.Write(data)
}
