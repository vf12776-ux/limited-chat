package main

import (
	"database/sql"
	"encoding/json"
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
	Status    string `json:"status"`
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
        to_username TEXT,
        text TEXT,
        is_file BOOLEAN,
        file_name TEXT,
        file_data BYTEA,
        type TEXT,
        timestamp BIGINT,
        status TEXT
    );
    `
	db.Exec(createTables)
}

func saveMessageToDB(m Message) error {
	_, err := db.Exec(`
        INSERT INTO messages(id, username, to_username, text, is_file, file_name, file_data, type, timestamp, status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		m.ID, m.Username, m.To, m.Text, m.IsFile, m.FileName, nil, m.Type, m.Timestamp, m.Status)
	return err
}

func updateMessageStatus(id, status string) {
	db.Exec("UPDATE messages SET status=$1 WHERE id=$2", status, id)
}

func loadHistoryForUser(username string) []Message {
	rows, err := db.Query(`
        SELECT id, username, to_username, text, is_file, file_name, type, timestamp, status
        FROM messages WHERE username=$1 OR to_username=$1 ORDER BY timestamp ASC`, username)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var msgs []Message
	for rows.Next() {
		var m Message
		var toPtr sql.NullString
		rows.Scan(&m.ID, &m.Username, &toPtr, &m.Text, &m.IsFile, &m.FileName, &m.Type, &m.Timestamp, &m.Status)
		if toPtr.Valid {
			m.To = toPtr.String
		}
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
	http.HandleFunc("/clear-chat", clearChatHandler)

	staticDir := "dist"
	http.Handle("/", http.FileServer(http.Dir(staticDir)))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("Server on :%s", port)
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

	// Отправить историю
	history := loadHistoryForUser(initMsg.Username)
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

		switch incoming.Type {
		case "msg":
			incoming.Status = "sent"
			if err := saveMessageToDB(incoming); err != nil {
				log.Println("save error:", err)
			}
			// Подтверждение отправителю
			conn.WriteJSON(Message{Type: "ack", ID: incoming.ID})
			broadcast <- incoming

		case "read":
			// Обновляем статус сообщения на "read"
			updateMessageStatus(incoming.ID, "read")
			// Отправляем событие всем клиентам отправителя этого сообщения
			var sender string
			db.QueryRow("SELECT username FROM messages WHERE id=$1", incoming.ID).Scan(&sender)
			for c := range clients {
				if c.username == sender {
					c.conn.WriteJSON(Message{Type: "read", ID: incoming.ID})
				}
			}

		case "delete":
			// Удаляем сообщение (только если это автор)
			var author string
			db.QueryRow("SELECT username FROM messages WHERE id=$1", incoming.ID).Scan(&author)
			if author == client.username {
				db.Exec("DELETE FROM messages WHERE id=$1", incoming.ID)
				for c := range clients {
					c.conn.WriteJSON(Message{Type: "delete", ID: incoming.ID})
				}
			}
		}
	}
}

func broadcastUserList() {
	mu.Lock()
	var list []string
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
		if msg.To == "" {
			for c := range clients {
				if c.username != msg.Username {
					c.conn.WriteJSON(msg)
				}
			}
		} else {
			for c := range clients {
				if c.username == msg.To {
					// доставлено получателю
					msg.Status = "delivered"
					updateMessageStatus(msg.ID, "delivered")
					c.conn.WriteJSON(msg)
				}
				if c.username == msg.Username {
					// отправитель, отправляем ему же, но статус уже sent
					c.conn.WriteJSON(msg)
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

	data, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "Read error", http.StatusInternalServerError)
		return
	}

	fileMsg := Message{
		ID:        uuid.New().String(),
		Text:      handler.Filename,
		IsFile:    true,
		FileName:  handler.Filename,
		Type:      "msg",
		Timestamp: time.Now().Unix(),
		Status:    "sent",
		FileUrl:   "/api/file/" + uuid.New().String(), // временно, обновим после сохранения
	}
	// Сохраняем в БД с данными файла
	_, err = db.Exec(`
        INSERT INTO messages(id, username, to_username, text, is_file, file_name, file_data, type, timestamp, status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		fileMsg.ID, "", "", fileMsg.Text, true, fileMsg.FileName, data, fileMsg.Type, fileMsg.Timestamp, fileMsg.Status)
	if err != nil {
		http.Error(w, "DB error", http.StatusInternalServerError)
		return
	}
	fileMsg.FileUrl = "/api/file/" + fileMsg.ID
	w.Write([]byte(fileMsg.FileUrl))
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

func clearChatHandler(w http.ResponseWriter, r *http.Request) {
	var req struct{ Username string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	db.Exec("DELETE FROM messages WHERE username=$1 OR to_username=$1", req.Username)
	w.WriteHeader(http.StatusOK)
}
