import React, { useState, useEffect, useRef } from 'react';

const Chat: React.FC<{ username: string }> = ({ username }) => {
    const [ws, setWs] = useState<WebSocket | null>(null);
    const [messages, setMessages] = useState<any[]>([]);
    const [inputText, setInputText] = useState('');
    const [isRecording, setIsRecording] = useState(false);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const [currentRoom, setCurrentRoom] = useState('public');
    const [rooms, setRooms] = useState<string[]>(['public']);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [unread, setUnread] = useState<Record<string, number>>({});
    const [darkTheme, setDarkTheme] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const [pendingMessages, setPendingMessages] = useState<any[]>([]);

    const sendWsMessage = (data: any) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
            return true;
        } else {
            setPendingMessages(prev => [...prev, data]);
            return false;
        }
    };

    useEffect(() => {
        if (ws && ws.readyState === WebSocket.OPEN && pendingMessages.length) {
            const toSend = [...pendingMessages];
            setPendingMessages([]);
            toSend.forEach(msg => ws.send(JSON.stringify(msg)));
        }
    }, [ws, pendingMessages]);

    useEffect(() => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        const socket = new WebSocket(wsUrl);

        socket.onopen = () => {
            socket.send(JSON.stringify({ type: 'hello', username }));
            socket.send(JSON.stringify({ type: 'join', room: currentRoom }));
        };

        socket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'ack') {
                setMessages(prev => prev.map(m => m.id === data.id ? { ...m, status: 'sent' } : m));
            } else if (data.type === 'msg' || data.type === 'image' || data.type === 'file' || (data.id && data.username)) {
                const msg = { ...data, status: 'sent' };
                setMessages(prev => {
                    if (prev.some(m => m.id === msg.id)) return prev;
                    return [...prev, msg];
                });
                if (msg.room && msg.room !== currentRoom) {
                    setUnread(prev => ({ ...prev, [msg.room]: (prev[msg.room] || 0) + 1 }));
                }
            } else if (data.type === 'delete') {
                setMessages(prev => prev.filter(m => m.id !== data.id));
            } else if (data.type === 'clear_chat') {
                setMessages([]);
            } else if (data.type === 'joined') {
                setCurrentRoom(data.room);
                setMessages([]);
            }
        };

        socket.onclose = () => {
            setTimeout(() => {
                setWs(null);
            }, 3000);
        };

        setWs(socket);
        return () => socket.close();
    }, [username]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const sendMessage = () => {
        if (!inputText.trim()) return;
        const id = Date.now().toString() + Math.random();
        const msg = {
            type: 'msg',
            id,
            text: inputText,
            username,
            room: currentRoom,
            timestamp: Date.now(),
            status: 'pending',
        };
        sendWsMessage(msg);
        setInputText('');
    };

    const sendFile = async (file: File) => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('username', username);
        formData.append('room', currentRoom);

        const id = Date.now().toString() + Math.random();
        const tempMsg = {
            id,
            type: 'msg',
            text: file.name,
            username,
            room: currentRoom,
            isFile: true,
            fileName: file.name,
            timestamp: Date.now(),
            status: 'pending',
            fileUrl: '',
        };
        setMessages(prev => [...prev, tempMsg]);

        try {
            const res = await fetch('/upload', { method: 'POST', body: formData });
            const fileUrl = await res.text();
            setMessages(prev => prev.map(m => m.id === id ? { ...m, fileUrl, status: 'sent' } : m));
        } catch (err) {
            setMessages(prev => prev.filter(m => m.id !== id));
        }
    };

    const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.[0]) sendFile(e.target.files[0]);
    };

    const startRecording = async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;
        audioChunksRef.current = [];
        recorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);
        recorder.onstop = () => {
            const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
            sendFile(new File([blob], 'voice.webm', { type: 'audio/webm' }));
            stream.getTracks().forEach(t => t.stop());
        };
        recorder.start();
        setIsRecording(true);
    };
    const stopRecording = () => {
        mediaRecorderRef.current?.stop();
        setIsRecording(false);
    };

    const deleteMessage = (id: string, msgUsername: string) => {
        if (msgUsername !== username) return;
        sendWsMessage({ type: 'delete', id });
        setMessages(prev => prev.filter(m => m.id !== id));
    };

    const clearChat = () => {
        if (window.confirm('Очистить чат?')) sendWsMessage({ type: 'clear_chat' });
    };

    const switchRoom = (room: string) => {
        if (room === currentRoom) return;
        setCurrentRoom(room);
        setMessages([]);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'join', room }));
        }
        setUnread(prev => ({ ...prev, [room]: 0 }));
        setSidebarOpen(false);
    };

    const createPrivateChat = () => {
        const other = prompt('Имя собеседника:');
        if (!other || other === username) return;
        const sorted = [username, other].sort();
        const roomName = `private_${sorted[0]}_${sorted[1]}`;
        setRooms(prev => prev.includes(roomName) ? prev : [...prev, roomName]);
        switchRoom(roomName);
    };

    const getRoomDisplayName = (room: string) => {
        if (room === 'public') return 'Общий чат';
        const match = room.match(/^private_(.+)_(.+)$/);
        if (match) return `Чат с ${match[1] === username ? match[2] : match[1]}`;
        return room;
    };

    const toggleTheme = () => setDarkTheme(prev => !prev);

    return (
        <div className={`chat-container ${darkTheme ? 'dark-theme' : ''}`}>
            <button className="menu-btn" onClick={() => setSidebarOpen(true)}>☰</button>
            <div className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
                <div className="sidebar-header">
                    <h3>Диалоги</h3>
                    <button className="close-sidebar" onClick={() => setSidebarOpen(false)}>✕</button>
                </div>
                <button className="new-chat-btn" onClick={createPrivateChat}>+ Приватный чат</button>
                <div className="rooms-list">
                    {rooms.map(room => (
                        <div key={room} className={`room-item ${currentRoom === room ? 'active' : ''}`} onClick={() => switchRoom(room)}>
                            <span>{getRoomDisplayName(room)}</span>
                            {unread[room] > 0 && <span className="unread-badge">{unread[room]}</span>}
                        </div>
                    ))}
                </div>
            </div>
            <div className={`overlay ${sidebarOpen ? 'open' : ''}`} onClick={() => setSidebarOpen(false)} />
            <div className="chat-main">
                <div className="chat-header">
                    <h2>{getRoomDisplayName(currentRoom)}</h2>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button onClick={toggleTheme} className="theme-toggle-btn">{darkTheme ? '☀️' : '🌙'}</button>
                        <button className="clear-chat-btn" onClick={clearChat}>🗑️ Очистить</button>
                    </div>
                </div>
                <div className="messages-area">
                    {messages.map((msg) => (
                        <div key={msg.id} className={`message ${msg.username === username ? 'own' : 'other'}`}>
                            <div className="message-header">
                                <strong>{msg.username}</strong>
                                <span className="message-time">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                                {msg.username === username && <button className="delete-btn" onClick={() => deleteMessage(msg.id, msg.username)}>🗑️</button>}
                                {msg.status === 'pending' && <span className="status">✓</span>}
                                {msg.status === 'sent' && <span className="status">✓✓</span>}
                            </div>
                            <div className="message-content">
                                {msg.isFile ? (
                                    msg.fileUrl ? (
                                        msg.fileName?.match(/\.(jpg|jpeg|png|gif)$/i) ?
                                            <img src={msg.fileUrl} alt="file" className="file-image" /> :
                                            <a href={msg.fileUrl} download={msg.fileName}>{msg.fileName}</a>
                                    ) : <span>Загрузка...</span>
                                ) : <p>{msg.text}</p>}
                            </div>
                        </div>
                    ))}
                    <div ref={messagesEndRef} />
                </div>
                <div className="input-area">
                    <input type="text" value={inputText} onChange={(e) => setInputText(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && sendMessage()} placeholder="Сообщение" />
                    <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={onFileSelect} />
                    <button onClick={() => fileInputRef.current?.click()} className="file-btn">📎</button>
                    <button className="voice-btn" onMouseDown={startRecording} onMouseUp={stopRecording} onTouchStart={startRecording} onTouchEnd={stopRecording} style={{ backgroundColor: isRecording ? 'red' : '#ccc' }}>🎤</button>
                    <button onClick={sendMessage} className="send-btn">➤</button>
                </div>
            </div>
        </div>
    );
};

export default Chat;