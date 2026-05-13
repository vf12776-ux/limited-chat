import React, { useState, useEffect, useRef } from 'react';
import './index.css';

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
    const fileInputRef = useRef<HTMLInputElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const [pendingMessages, setPendingMessages] = useState<any[]>([]);

    // Отправка через WebSocket с добавлением в очередь при офлайне
    const sendWsMessage = (data: any) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
            return true;
        } else {
            // Сохраняем в очередь с повторами
            setPendingMessages(prev => [...prev, { ...data, retries: 0 }]);
            return false;
        }
    };

    // Повторная отправка при восстановлении соединения
    useEffect(() => {
        if (ws && ws.readyState === WebSocket.OPEN && pendingMessages.length > 0) {
            const toSend = [...pendingMessages];
            setPendingMessages([]);
            toSend.forEach(msg => {
                ws.send(JSON.stringify(msg));
            });
        }
    }, [ws, pendingMessages]);

    // Подключение WebSocket
    useEffect(() => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        const socket = new WebSocket(wsUrl);

        socket.onopen = () => {
            socket.send(JSON.stringify({ type: 'hello', username }));
            // Отправляем join для текущей комнаты
            socket.send(JSON.stringify({ type: 'join', room: currentRoom }));
        };

        socket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'ack') {
                // Обновляем статус сообщения на 'sent'
                setMessages(prev =>
                    prev.map(msg =>
                        msg.id === data.id ? { ...msg, status: 'sent' } : msg
                    )
                );
            } else if (data.type === 'msg' || data.type === 'image' || data.type === 'file') {
                // Для совместимости – у тебя сервер шлёт type: "msg"
                if (data.room === currentRoom) {
                    setMessages(prev => [...prev, { ...data, status: 'sent' }]);
                } else {
                    // Увеличиваем счетчик непрочитанных
                    setUnread(prev => ({ ...prev, [data.room]: (prev[data.room] || 0) + 1 }));
                }
            } else if (data.type === 'delete') {
                setMessages(prev => prev.filter(msg => msg.id !== data.id));
            } else if (data.type === 'clear_chat') {
                setMessages([]);
            } else if (data.type === 'joined') {
                // После успешного join – очищаем сообщения и загрузим историю через последующие msg
                setMessages([]);
                setCurrentRoom(data.room);
            } else if (data.id && data.username && data.text) {
                // Обычное сообщение (история)
                if (data.room === currentRoom) {
                    setMessages(prev => [...prev, { ...data, status: 'sent' }]);
                } else if (data.room) {
                    setUnread(prev => ({ ...prev, [data.room]: (prev[data.room] || 0) + 1 }));
                }
            }
        };

        socket.onclose = () => {
            setTimeout(() => {
                setWs(null);
                // Переподключение
                const newSocket = new WebSocket(wsUrl);
                setWs(newSocket);
            }, 3000);
        };

        setWs(socket);
        return () => socket.close();
    }, [username]);

    // Автоскролл
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Отправка текстового сообщения
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
        setMessages(prev => [...prev, msg]);
        sendWsMessage(msg);
        setInputText('');
    };

    // Отправка файла
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
            // Обновляем сообщение с fileUrl
            setMessages(prev =>
                prev.map(msg => (msg.id === id ? { ...msg, fileUrl, status: 'sent' } : msg))
            );
        } catch (err) {
            console.error(err);
            setMessages(prev => prev.filter(msg => msg.id !== id));
        }
    };

    const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) sendFile(e.target.files[0]);
    };

    // Голосовая запись
    const startRecording = async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;
        audioChunksRef.current = [];
        recorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);
        recorder.onstop = () => {
            const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
            const file = new File([blob], 'voice.webm', { type: 'audio/webm' });
            sendFile(file);
            stream.getTracks().forEach(track => track.stop());
        };
        recorder.start();
        setIsRecording(true);
    };
    const stopRecording = () => {
        mediaRecorderRef.current?.stop();
        setIsRecording(false);
    };

    // Удаление сообщения (только своих)
    const deleteMessage = (id: string, msgUsername: string) => {
        if (msgUsername !== username) return;
        sendWsMessage({ type: 'delete', id });
        setMessages(prev => prev.filter(m => m.id !== id));
    };

    // Очистка чата (только для текущей комнаты)
    const clearChat = () => {
        if (window.confirm('Очистить все сообщения в этом чате?')) {
            sendWsMessage({ type: 'clear_chat' });
        }
    };

    // Переключение комнаты
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

    // Создание приватного чата
    const createPrivateChat = () => {
        const otherUser = prompt('Введите имя собеседника:');
        if (!otherUser || otherUser === username) return;
        const sorted = [username, otherUser].sort();
        const roomName = `private_${sorted[0]}_${sorted[1]}`;
        setRooms(prev => (prev.includes(roomName) ? prev : [...prev, roomName]));
        switchRoom(roomName);
    };

    // Форматирование имени комнаты для отображения
    const getRoomDisplayName = (room: string) => {
        if (room === 'public') return '🌍 Общий чат';
        const match = room.match(/^private_(.+)_(.+)$/);
        if (match) {
            const other = match[1] === username ? match[2] : match[1];
            return `👤 Чат с ${other}`;
        }
        return room;
    };

    return (
        <div className="chat-container">
            <button className="menu-btn" onClick={() => setSidebarOpen(true)}>☰</button>

            <div className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
                <div className="sidebar-header">
                    <h3>Диалоги</h3>
                    <button className="close-sidebar" onClick={() => setSidebarOpen(false)}>✕</button>
                </div>
                <button className="new-chat-btn" onClick={createPrivateChat}>+ Приватный чат</button>
                <div className="rooms-list">
                    {rooms.map(room => (
                        <div
                            key={room}
                            className={`room-item ${currentRoom === room ? 'active' : ''}`}
                            onClick={() => switchRoom(room)}
                        >
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
                    <button className="clear-chat-btn" onClick={clearChat}>🗑️ Очистить чат</button>
                </div>

                <div className="messages-area">
                    {messages.map((msg) => (
                        <div key={msg.id} className={`message ${msg.username === username ? 'own' : 'other'}`}>
                            <div className="message-header">
                                <strong>{msg.username}</strong>
                                <span className="message-time">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                                {msg.username === username && (
                                    <button className="delete-btn" onClick={() => deleteMessage(msg.id, msg.username)}>🗑️</button>
                                )}
                                {msg.status === 'pending' && <span className="status">✓</span>}
                                {msg.status === 'sent' && <span className="status">✓✓</span>}
                            </div>
                            <div className="message-content">
                                {msg.isFile ? (
                                    msg.fileUrl && (msg.fileName?.match(/\.(jpg|jpeg|png|gif)$/i) ? (
                                        <img src={msg.fileUrl} alt="file" className="file-image" />
                                    ) : (
                                        <a href={msg.fileUrl} download={msg.fileName}>{msg.fileName}</a>
                                    ))
                                ) : (
                                    <p>{msg.text}</p>
                                )}
                            </div>
                        </div>
                    ))}
                    <div ref={messagesEndRef} />
                </div>

                <div className="input-area">
                    <input
                        type="text"
                        value={inputText}
                        onChange={(e) => setInputText(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                        placeholder="Введите сообщение..."
                    />
                    <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={onFileSelect} />
                    <button onClick={() => fileInputRef.current?.click()} className="file-btn">📎</button>
                    <button
                        className="voice-btn"
                        onMouseDown={startRecording}
                        onMouseUp={stopRecording}
                        onTouchStart={startRecording}
                        onTouchEnd={stopRecording}
                        style={{ backgroundColor: isRecording ? 'red' : '#ccc' }}
                    >
                        🎤
                    </button>
                    <button onClick={sendMessage} className="send-btn">➤</button>
                </div>
            </div>
        </div>
    );
};

export default Chat;