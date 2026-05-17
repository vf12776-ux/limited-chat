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
		log.Fatal("FATAL: DATABASE_URL environment variable is not set")
	}
	log.Println("DB: connecting with DATABASE_URL")
	var err error
	db, err = sql.Open("postgres", connStr)
	if err != nil {
		log.Fatal("FATAL: sql.Open failed: ", err)
	}
	if err = db.Ping(); err != nil {
		log.Fatal("FATAL: database ping failed: ", err)
	}
	log.Println("DB: connected and ping successful")

	// Создаём таблицу, если её нет
	createTableSQL := `
	CREATE TABLE IF NOT EXISTS messages (
		id TEXT PRIMARY KEY,
		username TEXT,
		text TEXT,
		is_file BOOLEAN,
		file_name TEXT,
		file_data BYTEA,
		type TEXT,
		timestamp BIGINT
	)`
	if _, err = db.Exec(createTableSQL); err != nil {
		log.Fatal("FATAL: failed to create table: ", err)
	}
	log.Println("DB: table 'messages' ready")
}

func saveMessageToDB(m Message, fileData []byte) error {
	log.Printf("DB: saving message id=%s username=%s type=%s", m.ID, m.Username, m.Type)
	_, err := db.Exec(`
		INSERT INTO messages(id, username, text, is_file, file_name, file_data, type, timestamp)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		m.ID, m.Username, m.Text, m.IsFile, m.FileName, fileData, m.Type, m.Timestamp)
	if err != nil {
		log.Printf("DB ERROR: failed to insert message %s: %v", m.ID, err)
	} else {
		log.Printf("DB: message %s saved successfully", m.ID)
	}
	return err
}

func loadHistory() []Message {
	rows, err := db.Query(`SELECT id, username, text, is_file, file_name, type, timestamp FROM messages ORDER BY timestamp ASC`)
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
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("OK")) })

	spaHandler := http.FileServer(http.Dir("dist"))
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/ws") || strings.HasPrefix(r.URL.Path, "/upload") {
			http.NotFound(w, r)
			return
		}
		if _, err := os.Stat("dist" + r.URL.Path); err == nil {
			spaHandler.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, "dist/index.html")
	})
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
		return
	}

	client := &Client{conn: conn, username: initMsg.Username}
	mu.Lock()
	clients[client] = true
	mu.Unlock()

	for _, msg := range loadHistory() {
		conn.WriteJSON(msg)
	}

	for {
		var incoming Message
		err := conn.ReadJSON(&incoming)
		if err != nil {
			mu.Lock()
			delete(clients, client)
			mu.Unlock()
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
			saveMessageToDB(incoming, nil)
			conn.WriteJSON(Message{Type: "ack", ID: incoming.ID})
			broadcast <- incoming
		} else if incoming.Type == "delete" {
			var author string
			db.QueryRow("SELECT username FROM messages WHERE id=$1", incoming.ID).Scan(&author)
			if author == client.username {
				db.Exec("DELETE FROM messages WHERE id=$1", incoming.ID)
				mu.Lock()
				for c := range clients {
					c.conn.WriteJSON(Message{Type: "delete", ID: incoming.ID})
				}
				mu.Unlock()
			}
		} else if incoming.Type == "clear_chat" {
			if client.username != "" {
				db.Exec("DELETE FROM messages")
				mu.Lock()
				for c := range clients {
					c.conn.WriteJSON(Message{Type: "clear_chat"})
				}
				mu.Unlock()
			}
		}
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
	username := r.FormValue("username")
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
	saveMessageToDB(msg, data)
	msg.FileUrl = "/api/file/" + msg.ID
	broadcast <- msg
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
	} else if ext == ".webm" {
		ctype = "audio/webm"
	}
	w.Header().Set("Content-Type", ctype)
	w.Write(data)
}
