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
	Text      string `json:"text"`
	IsFile    bool   `json:"isFile,omitempty"`
	FileUrl   string `json:"fileUrl,omitempty"`
	FileName  string `json:"fileName,omitempty"`
	Type      string `json:"type"`
	Timestamp int64  `json:"timestamp"`
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
	connStr := os.Getenv("DATABASE_URL")
	if connStr == "" {
		log.Fatal("DATABASE_URL not set")
	}
	var err error
	db, err = sql.Open("postgres", connStr)
	if err != nil {
		log.Fatal(err)
	}
	createTables := `
	CREATE TABLE IF NOT EXISTS messages (
		id TEXT PRIMARY KEY,
		username TEXT,
		text TEXT,
		is_file BOOLEAN,
		file_name TEXT,
		file_data BYTEA,
		type TEXT,
		timestamp BIGINT
	);
	`
	db.Exec(createTables)
}

func saveMessageToDB(m Message, fileData []byte) error {
	_, err := db.Exec(`
		INSERT INTO messages(id, username, text, is_file, file_name, file_data, type, timestamp)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		m.ID, m.Username, m.Text, m.IsFile, m.FileName, fileData, m.Type, m.Timestamp)
	return err
}

func loadHistory() []Message {
	rows, err := db.Query(`
		SELECT id, username, text, is_file, file_name, type, timestamp
		FROM messages ORDER BY timestamp ASC
	`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var msgs []Message
	for rows.Next() {
		var m Message
		rows.Scan(&m.ID, &m.Username, &m.Text, &m.IsFile, &m.FileName, &m.Type, &m.Timestamp)
		if m.IsFile {
			m.FileUrl = "/api/file/" + m.ID
		}
		msgs = append(msgs, m)
	}
	return msgs
}

func main() {
	initDB()
	defer db.Close()
	go handleMessages()

	http.HandleFunc("/ws", wsHandler)
	http.HandleFunc("/upload", uploadHandler)
	http.HandleFunc("/api/file/", fileHandler)

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
		return
	}
	defer conn.Close()

	var initMsg Message
	if err := conn.ReadJSON(&initMsg); err != nil || initMsg.Type != "hello" || initMsg.Username == "" {
		conn.WriteJSON(Message{Type: "error", Text: "Invalid hello"})
		return
	}

	client := &Client{conn: conn, username: initMsg.Username}
	mu.Lock()
	clients[client] = true
	mu.Unlock()
	broadcastUserList()

	history := loadHistory()
	for _, msg := range history {
		conn.WriteJSON(msg)
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
		if incoming.ID == "" {
			incoming.ID = uuid.New().String()
		}
		if incoming.Timestamp == 0 {
			incoming.Timestamp = time.Now().Unix()
		}

		if incoming.Type == "msg" {
			// Сохраняем сообщение в БД (без данных файла, они уже есть, если это файл)
			saveMessageToDB(incoming, nil)
			// Подтверждение отправителю
			conn.WriteJSON(Message{Type: "ack", ID: incoming.ID})
			// Рассылаем всем
			broadcast <- incoming
		} else if incoming.Type == "delete" {
			var author string
			db.QueryRow("SELECT username FROM messages WHERE id=$1", incoming.ID).Scan(&author)
			if author == client.username {
				db.Exec("DELETE FROM messages WHERE id=$1", incoming.ID)
				for c := range clients {
					c.conn.WriteJSON(Message{Type: "delete", ID: incoming.ID})
				}
			}
		} else if incoming.Type == "clear_chat" {
			if client.username != "" {
				db.Exec("DELETE FROM messages")
				for c := range clients {
					c.conn.WriteJSON(Message{Type: "clear_chat"})
				}
			}
		}
	}
}

func broadcastUserList() {
	mu.Lock()
	list := []string{}
	for c := range clients {
		list = append(list, c.username)
	}
	mu.Unlock()
	msg := Message{Type: "userList", Text: strings.Join(list, ",")}
	for c := range clients {
		c.conn.WriteJSON(msg)
	}
}

func handleMessages() {
	for msg := range broadcast {
		mu.Lock()
		for c := range clients {
			c.conn.WriteJSON(msg)
		}
		mu.Unlock()
	}
}

func uploadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	username := r.FormValue("username") // получаем имя пользователя
	if username == "" {
		http.Error(w, "username required", http.StatusBadRequest)
		return
	}
	r.ParseMultipartForm(10 << 20)
	file, handler, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "File error", http.StatusBadRequest)
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "Read error", http.StatusInternalServerError)
		return
	}

	msg := Message{
		ID:        uuid.New().String(),
		Username:  username,
		Text:      handler.Filename,
		IsFile:    true,
		FileName:  handler.Filename,
		Type:      "msg",
		Timestamp: time.Now().Unix(),
	}
	// Сохраняем с данными файла
	err = saveMessageToDB(msg, data)
	if err != nil {
		http.Error(w, "DB error", http.StatusInternalServerError)
		return
	}
	msg.FileUrl = "/api/file/" + msg.ID
	// Отправляем это сообщение в broadcast
	broadcast <- msg
	// Возвращаем URL клиенту (клиент может его игнорировать)
	w.Write([]byte(msg.FileUrl))
}

func fileHandler(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/file/")
	var data []byte
	var fileName string
	err := db.QueryRow("SELECT file_data, file_name FROM messages WHERE id=$1", id).Scan(&data, &fileName)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	ext := strings.ToLower(filepath.Ext(fileName))
	ctype := "application/octet-stream"
	if ext == ".jpg" || ext == ".jpeg" {
		ctype = "image/jpeg"
	} else if ext == ".png" {
		ctype = "image/png"
	} else if ext == ".gif" {
		ctype = "image/gif"
	}
	w.Header().Set("Content-Type", ctype)
	w.Write(data)
}
