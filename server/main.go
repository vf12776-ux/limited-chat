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
	db.Exec(`CREATE TABLE IF NOT EXISTS messages (
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
	db.Exec(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS room TEXT DEFAULT 'public'`)
}

func saveMessage(m Message, fileData []byte) error {
	_, err := db.Exec(
		`INSERT INTO messages(id, username, text, room, is_file, file_name, file_data, type, timestamp)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		m.ID, m.Username, m.Text, m.Room, m.IsFile, m.FileName, fileData, m.Type, m.Timestamp,
	)
	return err
}

func loadHistory(room string) []Message {
	rows, err := db.Query(`SELECT id, username, text, is_file, file_name, type, timestamp FROM messages WHERE room=$1 ORDER BY timestamp ASC`, room)
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

	var hello Message
	if err := conn.ReadJSON(&hello); err != nil || hello.Type != "hello" || hello.Username == "" {
		return
	}

	client := &Client{conn: conn, username: hello.Username, room: "public"}
	mu.Lock()
	if rooms["public"] == nil {
		rooms["public"] = make(map[*Client]bool)
	}
	rooms["public"][client] = true
	mu.Unlock()

	for _, msg := range loadHistory("public") {
		conn.WriteJSON(msg)
	}

	for {
		var msg Message
		err := conn.ReadJSON(&msg)
		if err != nil {
			mu.Lock()
			delete(rooms[client.room], client)
			mu.Unlock()
			break
		}
		msg.Username = client.username
		if msg.ID == "" {
			msg.ID = uuid.New().String()
		}
		if msg.Timestamp == 0 {
			msg.Timestamp = time.Now().Unix()
		}

		switch msg.Type {
		case "msg":
			room := msg.Room
			if room == "" {
				room = "public"
			}
			msg.Room = room
			saveMessage(msg, nil)
			conn.WriteJSON(Message{Type: "ack", ID: msg.ID})
			mu.Lock()
			for c := range rooms[room] {
				c.conn.WriteJSON(msg)
			}
			mu.Unlock()

		case "join":
			newRoom := msg.Room
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
			for _, m := range loadHistory(newRoom) {
				conn.WriteJSON(m)
			}
			conn.WriteJSON(Message{Type: "joined", Room: newRoom})

		case "delete":
			var author string
			db.QueryRow("SELECT username FROM messages WHERE id=$1", msg.ID).Scan(&author)
			if author == client.username {
				db.Exec("DELETE FROM messages WHERE id=$1", msg.ID)
				mu.Lock()
				for c := range rooms[client.room] {
					c.conn.WriteJSON(Message{Type: "delete", ID: msg.ID})
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
		http.Error(w, "", http.StatusMethodNotAllowed)
		return
	}
	username := r.FormValue("username")
	room := r.FormValue("room")
	if username == "" {
		http.Error(w, "no username", http.StatusBadRequest)
		return
	}
	if room == "" {
		room = "public"
	}
	r.ParseMultipartForm(10 << 20)
	file, handler, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "", http.StatusBadRequest)
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "", http.StatusInternalServerError)
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
	saveMessage(msg, data)
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
		http.Error(w, "", http.StatusNotFound)
		return
	}
	ext := filepath.Ext(fileName)
	ctype := "application/octet-stream"
	switch ext {
	case ".jpg", ".jpeg":
		ctype = "image/jpeg"
	case ".png":
		ctype = "image/png"
	case ".gif":
		ctype = "image/gif"
	case ".webm":
		ctype = "audio/webm"
	}
	w.Header().Set("Content-Type", ctype)
	w.Write(data)
}
