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
	Room      string `json:"room,omitempty"`
	IsFile    bool   `json:"isFile,omitempty"`
	FileUrl   string `json:"fileUrl,omitempty"`
	FileName  string `json:"fileName,omitempty"`
	Type      string `json:"type"`
	Timestamp int64  `json:"timestamp"`
}

type Client struct {
	conn     *websocket.Conn
	username string
	room     string
}

var (
	rooms = make(map[string]map[*Client]bool)
	mu    sync.Mutex
	db    *sql.DB
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
	// Таблица с полем room
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS messages (
		id TEXT PRIMARY KEY,
		username TEXT,
		text TEXT,
		room TEXT DEFAULT 'public',
		is_file BOOLEAN,
		file_name TEXT,
		file_data BYTEA,
		type TEXT,
		timestamp BIGINT
	)`)
	if err != nil {
		log.Fatal("Create table error:", err)
	}
	// Добавляем колонку room, если её нет (миграция)
	_, err = db.Exec(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS room TEXT DEFAULT 'public'`)
	if err != nil {
		log.Println("Warning: adding room column:", err)
	}
	log.Println("Database initialized")
}

func saveMessageToDB(m Message, fileData []byte) error {
	_, err := db.Exec(`
		INSERT INTO messages(id, username, text, room, is_file, file_name, file_data, type, timestamp)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		m.ID, m.Username, m.Text, m.Room, m.IsFile, m.FileName, fileData, m.Type, m.Timestamp)
	return err
}

func loadHistory(room string) []Message {
	rows, err := db.Query(`
		SELECT id, username, text, is_file, file_name, type, timestamp
		FROM messages WHERE room = $1 ORDER BY timestamp ASC`, room)
	if err != nil {
		log.Println("loadHistory error:", err)
		return nil
	}
	defer rows.Close()
	var msgs []Message
	for rows.Next() {
		var m Message
		err := rows.Scan(&m.ID, &m.Username, &m.Text, &m.IsFile, &m.FileName, &m.Type, &m.Timestamp)
		if err != nil {
			log.Println("scan error:", err)
			continue
		}
		if m.IsFile {
			m.FileUrl = "/api/file/" + m.ID
		}
		m.Room = room
		msgs = append(msgs, m)
	}
	return msgs
}

func main() {
	initDB()
	defer db.Close()

	http.HandleFunc("/ws", wsHandler)
	http.HandleFunc("/upload", uploadHandler)
	http.HandleFunc("/api/file/", fileHandler)
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("OK")) })

	http.Handle("/", http.FileServer(http.Dir("dist")))
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

	client := &Client{conn: conn, username: initMsg.Username, room: "public"}
	mu.Lock()
	if rooms["public"] == nil {
		rooms["public"] = make(map[*Client]bool)
	}
	rooms["public"][client] = true
	mu.Unlock()

	// Отправляем историю общего чата
	for _, msg := range loadHistory("public") {
		conn.WriteJSON(msg)
	}

	for {
		var incoming Message
		err := conn.ReadJSON(&incoming)
		if err != nil {
			mu.Lock()
			delete(rooms[client.room], client)
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

		switch incoming.Type {
		case "msg":
			room := incoming.Room
			if room == "" {
				room = "public"
			}
			incoming.Room = room
			// Сохраняем в БД
			if err := saveMessageToDB(incoming, nil); err != nil {
				log.Printf("DB save error: %v", err)
			}
			// Подтверждение
			conn.WriteJSON(Message{Type: "ack", ID: incoming.ID})
			// Рассылаем всем в этой комнате
			mu.Lock()
			for c := range rooms[room] {
				c.conn.WriteJSON(incoming)
			}
			mu.Unlock()

		case "join":
			newRoom := incoming.Room
			if newRoom == "" {
				newRoom = "public"
			}
			mu.Lock()
			delete(rooms[client.room], client)
			if rooms[newRoom] == nil {
				rooms[newRoom] = make(map[*Client]bool)
			}
			rooms[newRoom][client] = true
			client.room = newRoom
			mu.Unlock()
			// Отправляем историю новой комнаты
			for _, m := range loadHistory(newRoom) {
				conn.WriteJSON(m)
			}
			conn.WriteJSON(Message{Type: "joined", Room: newRoom})

		case "delete":
			var author string
			db.QueryRow("SELECT username FROM messages WHERE id=$1", incoming.ID).Scan(&author)
			if author == client.username {
				db.Exec("DELETE FROM messages WHERE id=$1", incoming.ID)
				mu.Lock()
				for c := range rooms[client.room] {
					c.conn.WriteJSON(Message{Type: "delete", ID: incoming.ID})
				}
				mu.Unlock()
			}

		case "clear_chat":
			if client.username != "" {
				db.Exec("DELETE FROM messages WHERE room=$1", client.room)
				mu.Lock()
				for c := range rooms[client.room] {
					c.conn.WriteJSON(Message{Type: "clear_chat"})
				}
				mu.Unlock()
			}
		}
	}
}

func uploadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	username := r.FormValue("username")
	room := r.FormValue("room")
	if username == "" {
		http.Error(w, "username required", http.StatusBadRequest)
		return
	}
	if room == "" {
		room = "public"
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
		Room:      room,
		IsFile:    true,
		FileName:  handler.Filename,
		Type:      "msg",
		Timestamp: time.Now().Unix(),
	}
	if err := saveMessageToDB(msg, data); err != nil {
		http.Error(w, "DB error", http.StatusInternalServerError)
		return
	}
	msg.FileUrl = "/api/file/" + msg.ID
	mu.Lock()
	for c := range rooms[room] {
		c.conn.WriteJSON(msg)
	}
	mu.Unlock()
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
