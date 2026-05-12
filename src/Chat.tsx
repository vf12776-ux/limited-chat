import { useState, useEffect, useRef } from 'react';

interface Message {
  id: string;
  username: string;
  text: string;
  room?: string;
  isFile?: boolean;
  fileUrl?: string;
  fileName?: string;
  type?: string;
  timestamp: number;
  status?: 'pending' | 'sent';
}

interface PendingFile {
  id: string;
  formData: FormData;
  fileName: string;
  retryCount: number;
}

const IOSInstallPrompt = ({ onClose }: { onClose: () => void }) => {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return (
    <div style={{
      position: 'fixed',
      bottom: '80px',
      left: '20px',
      right: '20px',
      background: '#1c1c1e',
      color: 'white',
      padding: '14px',
      borderRadius: '16px',
      zIndex: 2000,
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '10px',
      fontSize: '14px',
    }}>
      <div style={{ fontWeight: 'bold' }}>📱 Установите приложение</div>
      <div style={{ textAlign: 'center' }}>Нажмите «Поделиться» → «На экран „Домой“»</div>
      <button onClick={() => { setVisible(false); onClose(); }} style={{ background: '#007aff', border: 'none', color: 'white', padding: '6px 20px', borderRadius: '20px', cursor: 'pointer' }}>Понятно</button>
    </div>
  );
};

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [username, setUsername] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isJoined, setIsJoined] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [currentRoom, setCurrentRoom] = useState('public');
  const [rooms, setRooms] = useState<string[]>(['public']);
  const [targetUser, setTargetUser] = useState('');
  const [showIOSPrompt, setShowIOSPrompt] = useState(false);
  
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pendingMessagesRef = useRef<Message[]>([]);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<any>();
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const pendingFilesRef = useRef<PendingFile[]>([]);
  const retryIntervalRef = useRef<any>();
  // iOS prompt
  useEffect(() => {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
    if (isIOS && !isStandalone && !localStorage.getItem('iosPromptClosed')) {
      setShowIOSPrompt(true);
    }
  }, []);

  const closeIOSPrompt = () => {
    setShowIOSPrompt(false);
    localStorage.setItem('iosPromptClosed', 'true');
  };

  // WebSocket
  const connectWebSocket = () => {
    if (!isJoined) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      reconnectAttemptsRef.current = 0;
      ws.send(JSON.stringify({ type: 'hello', username }));
      if (pendingMessagesRef.current.length) {
        const toSend = [...pendingMessagesRef.current];
        pendingMessagesRef.current = [];
        toSend.forEach(msg => ws.send(JSON.stringify(msg)));
      }
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'delete') {
        setMessages(prev => prev.filter(m => m.id !== data.id));
      } else if (data.type === 'msg' || data.type === '') {
        setMessages(prev => {
          const exists = prev.some(m => m.id === data.id);
          if (exists) return prev;
          const newMsg = { ...data, status: data.username === username ? 'sent' : undefined };
          return [...prev, newMsg];
        });
        pendingMessagesRef.current = pendingMessagesRef.current.filter(p => p.id !== data.id);
      } else if (data.type === 'ack') {
        setMessages(prev =>
          prev.map(msg =>
            msg.id === data.id && msg.username === username ? { ...msg, status: 'sent' } : msg
          )
        );
      } else if (data.type === 'clear_chat') {
        setMessages([]);
      } else if (data.type === 'joined') {
        setCurrentRoom(data.Room);
        // История уже загрузится отдельными сообщениями
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttemptsRef.current));
      reconnectAttemptsRef.current++;
      reconnectTimeoutRef.current = window.setTimeout(connectWebSocket, delay);
    };
  };

  useEffect(() => {
    if (isJoined) connectWebSocket();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [isJoined]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Переключение комнаты
  const switchRoom = (room: string) => {
    if (room === currentRoom) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'join', room }));
    }
    setMessages([]); // очищаем, пока сервер не пришлёт историю новой комнаты
    setCurrentRoom(room);
  };

  // Создание приватного чата
  const createPrivateChat = () => {
    const other = targetUser.trim();
    if (!other || other === username) {
      alert('Введите корректное имя другого участника');
      return;
    }
    const sorted = [username, other].sort();
    const privateRoom = `private_${sorted[0]}_${sorted[1]}`;
    if (!rooms.includes(privateRoom)) {
      setRooms([...rooms, privateRoom]);
    }
    switchRoom(privateRoom);
    setTargetUser('');
  };

  // Отправка текста
  const sendMessage = (text: string) => {
    const msg: Message = {
      id: Date.now().toString() + Math.random(),
      type: 'msg',
      username,
      text,
      room: currentRoom,
      timestamp: Date.now(),
      status: 'pending',
    };
    setMessages(prev => [...prev, msg]);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    } else {
      pendingMessagesRef.current.push(msg);
    }
  };

  // Удаление сообщения
  const deleteMessage = (id: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'delete', id }));
    }
  };

  // Очистка чата
  const clearChat = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'clear_chat' }));
    }
  };

  const handleSendText = () => {
    if (input.trim() === '') return;
    sendMessage(input);
    setInput('');
  };

  // Файлы (упрощённо, без прогресса, но с ретраем)
  const uploadFileWithRetry = async (formData: FormData, fileName: string, tempId: string, retries: number) => {
    try {
      const response = await fetch('/upload', { method: 'POST', body: formData });
      if (!response.ok) throw new Error();
      pendingFilesRef.current = pendingFilesRef.current.filter(f => f.id !== tempId);
      setMessages(prev =>
        prev.map(msg =>
          msg.id === tempId && msg.username === username ? { ...msg, status: 'sent' } : msg
        )
      );
    } catch (err) {
      if (retries < 5) {
        pendingFilesRef.current.push({ id: tempId, formData, fileName, retryCount: retries + 1 });
      } else {
        setMessages(prev =>
          prev.map(msg =>
            msg.id === tempId ? { ...msg, text: `❌ ${msg.text} (ошибка отправки)` } : msg
          )
        );
      }
    }
  };

  const sendFile = async (file: File, type: 'file' | 'voice' = 'file') => {
    const tempId = Date.now().toString() + Math.random();
    const displayName = type === 'voice' ? '🎤 Голосовое сообщение' : file.name;
    const tmpMsg: Message = {
      id: tempId,
      username,
      text: displayName,
      room: currentRoom,
      isFile: true,
      fileName: file.name,
      fileUrl: '',
      timestamp: Date.now(),
      status: 'pending',
    };
    setMessages(prev => [...prev, tmpMsg]);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('username', username);
    formData.append('room', currentRoom);
    pendingFilesRef.current.push({ id: tempId, formData, fileName: file.name, retryCount: 0 });
    await uploadFileWithRetry(formData, file.name, tempId, 0);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await sendFile(file, 'file');
      e.target.value = '';
    }
  };

  // Голосовые сообщения
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const audioFile = new File([audioBlob], `voice_${Date.now()}.webm`, { type: 'audio/webm' });
        await sendFile(audioFile, 'voice');
        stream.getTracks().forEach(t => t.stop());
        setIsRecording(false);
      };
      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      alert('Не удалось получить доступ к микрофону');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
    }
  };

  const isImageFile = (name?: string) => {
    if (!name) return false;
    const ext = name.split('.').pop()?.toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext || '');
  };

  const isAudioFile = (name?: string) => {
    if (!name) return false;
    const ext = name.split('.').pop()?.toLowerCase();
    return ['webm', 'mp3', 'wav', 'ogg'].includes(ext || '');
  };

  // Регулярная попытка отправить файлы
  useEffect(() => {
    if (isJoined) {
      retryIntervalRef.current = window.setInterval(() => {
  if (navigator.onLine) {
    const toRetry = [...pendingFilesRef.current];
    pendingFilesRef.current = [];
    toRetry.forEach(f => uploadFileWithRetry(f.formData, f.fileName, f.id, f.retryCount));
  }
}, 30000);
    }
    return () => clearInterval(retryIntervalRef.current);
  }, [isJoined]);

  if (!isJoined) {
    return (
      <div style={{ maxWidth: '400px', margin: '50px auto', textAlign: 'center' }}>
        <h2>P2P Messenger</h2>
        <input
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder="Ваше имя"
          style={{ padding: '10px', width: '80%', marginBottom: '10px' }}
        />
        <button onClick={() => setIsJoined(true)} style={{ padding: '10px 20px' }}>Войти</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100vh', maxWidth: '1400px', margin: '0 auto' }}>
      {/* Левая панель */}
      <div style={{ width: '260px', background: '#f8f9fa', borderRight: '1px solid #dee2e6', padding: '12px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '16px' }}>Диалоги</div>
        <div style={{ marginBottom: '16px' }}>
          <input
            type="text"
            placeholder="Имя собеседника"
            value={targetUser}
            onChange={e => setTargetUser(e.target.value)}
            style={{ width: '100%', padding: '6px', marginBottom: '8px' }}
          />
          <button onClick={createPrivateChat} style={{ width: '100%', padding: '6px', background: '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
            + Приватный чат
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {rooms.map(room => (
            <div
              key={room}
              onClick={() => switchRoom(room)}
              style={{
                padding: '10px',
                marginBottom: '4px',
                background: currentRoom === room ? '#e7f3ff' : 'transparent',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: currentRoom === room ? 'bold' : 'normal',
              }}
            >
              {room === 'public' ? '🌍 Общий чат' : room.replace('private_', '👤 ')}
            </div>
          ))}
        </div>
      </div>

      {/* Основная область */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px', background: '#f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{currentRoom === 'public' ? 'Общий чат' : `Приватный чат с ${currentRoom.replace('private_', '').replace(`_${username}`, '').replace(`${username}_`, '')}`}</span>
          <span style={{ fontSize: '12px', color: isConnected ? 'green' : 'red' }}>{isConnected ? '● Онлайн' : '○ Офлайн'}</span>
          <button onClick={clearChat} style={{ background: '#dc3545', color: 'white', border: 'none', borderRadius: '20px', padding: '5px 12px', cursor: 'pointer' }}>Очистить чат</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px', background: '#fff' }}>
          {messages.map(msg => (
            <div key={msg.id} style={{
              marginBottom: '12px',
              textAlign: msg.username === username ? 'right' : 'left',
              display: 'flex',
              alignItems: 'baseline',
              gap: '8px',
              justifyContent: msg.username === username ? 'flex-end' : 'flex-start'
            }}>
              <div style={{
                background: msg.username === username ? '#dcf8c5' : '#fff',
                border: '1px solid #ddd',
                borderRadius: '12px',
                padding: '8px 12px',
                maxWidth: '70%',
              }}>
                <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>{msg.username}</div>
                {msg.isFile ? (
                  isImageFile(msg.fileName) ? (
                    <img src={msg.fileUrl} alt={msg.fileName} style={{ maxWidth: '200px', maxHeight: '200px', borderRadius: '8px' }} />
                  ) : isAudioFile(msg.fileName) ? (
                    <audio controls src={msg.fileUrl} style={{ minWidth: '200px' }} />
                  ) : (
                    <a href={msg.fileUrl} target="_blank" rel="noopener noreferrer">{msg.fileName || msg.text}</a>
                  )
                ) : (
                  <div>{msg.text}</div>
                )}
                <div style={{ fontSize: '10px', color: '#aaa', marginTop: '4px', display: 'flex', gap: '4px' }}>
                  {new Date(msg.timestamp).toLocaleTimeString()}
                  {msg.username === username && (
                    <span>{msg.status === 'pending' ? '✓' : msg.status === 'sent' ? '✓✓' : ''}</span>
                  )}
                </div>
              </div>
              {msg.username === username && (
                <button onClick={() => deleteMessage(msg.id)} style={{ background: 'none', border: 'none', color: 'red', cursor: 'pointer', fontSize: '18px' }}>🗑️</button>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div style={{ padding: '10px', background: '#f0f0f0', display: 'flex', gap: '8px' }}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSendText()}
            placeholder="Сообщение..."
            style={{ flex: 1, padding: '10px', borderRadius: '20px', border: '1px solid #ccc' }}
          />
          <button onClick={handleSendText} style={{ padding: '10px 20px', borderRadius: '20px', border: 'none', background: '#007bff', color: 'white', cursor: 'pointer' }}>➤</button>
          <label style={{ background: '#28a745', padding: '10px 15px', borderRadius: '20px', color: 'white', cursor: 'pointer' }}>
            📎
            <input type="file" onChange={handleFileUpload} style={{ display: 'none' }} />
          </label>
          <button
            onMouseDown={startRecording}
            onMouseUp={stopRecording}
            onTouchStart={startRecording}
            onTouchEnd={stopRecording}
            style={{
              background: isRecording ? '#dc3545' : '#ff9800',
              padding: '10px 15px',
              borderRadius: '20px',
              border: 'none',
              color: 'white',
              cursor: 'pointer',
            }}
          >
            {isRecording ? '🔴 Запись...' : '🎤'}
          </button>
        </div>
      </div>

      {showIOSPrompt && <IOSInstallPrompt onClose={closeIOSPrompt} />}
    </div>
  );
}