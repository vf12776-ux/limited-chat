package main

import (
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
	clients    = make(map[*Client]bool)
	mu         sync.Mutex
	broadcast  = make(chan Message)
	history    = []Message{}
	historyMu  sync.RWMutex
	maxHistory = 200
)

func main() {
	go handleMessages()

	http.HandleFunc("/ws", wsHandler)
	http.HandleFunc("/upload", uploadHandler)
	http.HandleFunc("/download/", downloadHandler)

	// Раздача статики из папки dist (находится в той же директории, что и бинарник)
	staticDir := "dist"
	http.Handle("/", http.StripPrefix("/", http.FileServer(http.Dir(staticDir))))

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

	historyMu.RLock()
	for _, h := range history {
		conn.WriteJSON(h)
	}
	historyMu.RUnlock()

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
		if msg.Type == "msg" {
			historyMu.Lock()
			history = append(history, msg)
			if len(history) > maxHistory {
				history = history[len(history)-maxHistory:]
			}
			historyMu.Unlock()
		} else if msg.Type == "delete" {
			historyMu.Lock()
			newHistory := []Message{}
			for _, m := range history {
				if m.ID != msg.ID {
					newHistory = append(newHistory, m)
				}
			}
			history = newHistory
			historyMu.Unlock()
			for client := range clients {
				client.conn.WriteJSON(Message{Type: "delete", ID: msg.ID})
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
