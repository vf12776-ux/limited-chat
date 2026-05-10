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
	_ "modernc.org/sqlite"
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
	var err error
	db, err = sql.Open("sqlite", "./messages.db")
	if err != nil {
		log.Fatal(err)
	}
	createTable := `
    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        username TEXT,
        to_username TEXT,
        text TEXT,
        is_file BOOLEAN,
        file_url TEXT,
        file_name TEXT,
        type TEXT,
        timestamp INTEGER
    );
    `
	_, err = db.Exec(createTable)
	if err != nil {
		log.Fatal(err)
	}
}

func loadHistory() []Message {
	rows, err := db.Query("SELECT id, username, to_username, text, is_file, file_url, file_name, type, timestamp FROM messages ORDER BY timestamp ASC")
	if err != nil {
		log.Println("loadHistory error:", err)
		return []Message{}
	}
	defer rows.Close()
	var history []Message
	for rows.Next() {
		var m Message
		var toPtr sql.NullString
		err := rows.Scan(&m.ID, &m.Username, &toPtr, &m.Text, &m.IsFile, &m.FileUrl, &m.FileName, &m.Type, &m.Timestamp)
		if err != nil {
			log.Println("scan error:", err)
			continue
		}
		if toPtr.Valid {
			m.To = toPtr.String
		}
		history = append(history, m)
	}
	return history
}

func saveMessageToDB(m Message) {
	_, err := db.Exec("INSERT INTO messages(id, username, to_username, text, is_file, file_url, file_name, type, timestamp) VALUES(?,?,?,?,?,?,?,?,?)",
		m.ID, m.Username, m.To, m.Text, m.IsFile, m.FileUrl, m.FileName, m.Type, m.Timestamp)
	if err != nil {
		log.Println("saveMessage error:", err)
	}
}

func deleteMessageFromDB(id string) {
	_, err := db.Exec("DELETE FROM messages WHERE id = ?", id)
	if err != nil {
		log.Println("deleteMessage error:", err)
	}
}

func main() {
	initDB()
	defer db.Close()

	// Загружаем историю из БД
	history := loadHistory()
	// Отправим историю новым клиентам
	go handleMessages(history)

	http.HandleFunc("/ws", wsHandler)
	http.HandleFunc("/upload", uploadHandler)
	http.HandleFunc("/download/", downloadHandler)

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

	var msg Message
	err = conn.ReadJSON(&msg)
	if err != nil || msg.Type != "hello" || msg.Username == "" {
		conn.WriteJSON(Message{Type: "error", Text: "Invalid hello"})
		return
	}

	client := &Client{conn: conn, username: msg.Username}
	mu.Lock()
	clients[client] = true
	mu.Unlock()
	broadcastUserList()

	// Отправляем историю из БД
	history := loadHistory()
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

		// Сохраняем в БД, если это не служебное сообщение (не delete)
		if incoming.Type != "delete" {
			saveMessageToDB(incoming)
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

func handleMessages(initialHistory []Message) {
	// Сначала отправим сохранённые сообщения всем текущим клиентам? Они уже отправлены при подключении.
	for {
		msg := <-broadcast
		if msg.Type == "delete" {
			// Удаляем из БД, только если отправитель совпадает с автором сообщения
			// Нужно проверить в БД, кто автор. Лучше при удалении передавать ID, а мы уже знаем автора из сообщения?
			// При удалении мы получаем только ID. Поэтому запросим автора из БД.
			var author string
			err := db.QueryRow("SELECT username FROM messages WHERE id = ?", msg.ID).Scan(&author)
			if err == nil && author == msg.Username {
				deleteMessageFromDB(msg.ID)
				// Уведомляем всех об удалении
				for client := range clients {
					client.conn.WriteJSON(Message{Type: "delete", ID: msg.ID})
				}
			} else {
				log.Println("Unauthorized delete attempt by", msg.Username, "for msg", msg.ID)
			}
			continue
		}

		// Рассылаем сообщение всем, кому нужно
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
	r.ParseMultipartForm(10 << 20)
	file, handler, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "File error", http.StatusBadRequest)
		return
	}
	defer file.Close()

	os.MkdirAll("uploads", os.ModePerm)
	filePath := filepath.Join("uploads", handler.Filename)
	dst, err := os.Create(filePath)
	if err != nil {
		http.Error(w, "Server error", http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	io.Copy(dst, file)
	w.Write([]byte("/download/" + handler.Filename))
}

func downloadHandler(w http.ResponseWriter, r *http.Request) {
	filename := strings.TrimPrefix(r.URL.Path, "/download/")
	filePath := filepath.Join("uploads", filename)
	http.ServeFile(w, r, filePath)
}
