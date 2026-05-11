import { useState, useEffect, useRef } from 'react';

interface Message {
  id: string;
  username: string;
  text: string;
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

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [username, setUsername] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isJoined, setIsJoined] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pendingMessagesRef = useRef<Message[]>([]);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<number>();
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const pendingFilesRef = useRef<PendingFile[]>([]);
  const retryIntervalRef = useRef<number>();

  // ----- WebSocket (без изменений) -----
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
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttemptsRef.current));
      reconnectAttemptsRef.current++;
      reconnectTimeoutRef.current = window.setTimeout(connectWebSocket, delay);
    };

    ws.onerror = () => ws.close();
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

  // ----- Очередь файлов с повторными попытками (без прогресс-бара) -----
  const uploadFileWithRetry = async (formData: FormData, fileName: string, tempId: string, retries: number) => {
    try {
      const response = await fetch('/upload', { method: 'POST', body: formData });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Успех
      pendingFilesRef.current = pendingFilesRef.current.filter(f => f.id !== tempId);
      setMessages(prev =>
        prev.map(msg =>
          msg.id === tempId && msg.username === username ? { ...msg, status: 'sent' } : msg
        )
      );
    } catch (err) {
      if (retries < 5) {
        pendingFilesRef.current.push({ id: tempId, formData, fileName, retryCount: retries + 1 });
        console.log(`Retry ${retries + 1}/5 for ${fileName}`);
      } else {
        setMessages(prev =>
          prev.map(msg =>
            msg.id === tempId ? { ...msg, text: `❌ ${msg.text} (ошибка отправки)` } : msg
          )
        );
      }
    }
  };

  const retryPendingFiles = async () => {
    if (pendingFilesRef.current.length === 0) return;
    const toRetry = [...pendingFilesRef.current];
    pendingFilesRef.current = [];
    for (const fileItem of toRetry) {
      await uploadFileWithRetry(fileItem.formData, fileItem.fileName, fileItem.id, fileItem.retryCount);
    }
  };

  const sendFile = async (file: File, type: 'file' | 'voice' = 'file') => {
    const tempId = Date.now().toString() + Math.random();
    const displayName = type === 'voice' ? '🎤 Голосовое сообщение' : file.name;
    const tmpMsg: Message = {
      id: tempId,
      username,
      text: displayName,
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
    pendingFilesRef.current.push({ id: tempId, formData, fileName: file.name, retryCount: 0 });
    await uploadFileWithRetry(formData, file.name, tempId, 0);
  };

  // ----- Текстовые сообщения -----
  const sendMessage = (text: string, isFile = false, fileUrl = '', fileName = '') => {
    const msg: Message = {
      id: Date.now().toString() + Math.random(),
      type: 'msg',
      username,
      text,
      isFile,
      fileUrl,
      fileName,
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

  const deleteMessage = (id: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'delete', id }));
  };

  const clearChat = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'clear_chat' }));
  };

  const handleSendText = () => {
    if (input.trim() === '') return;
    sendMessage(input);
    setInput('');
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await sendFile(file, 'file');
    e.target.value = '';
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const audioFile = new File([audioBlob], `voice_${Date.now()}.webm`, { type: 'audio/webm' });
        await sendFile(audioFile, 'voice');
        stream.getTracks().forEach(track => track.stop());
        setIsRecording(false);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error(err);
      alert('Не удалось получить доступ к микрофону');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
    }
  };

  const isImageFile = (fileName?: string): boolean => {
    if (!fileName) return false;
    const ext = fileName.split('.').pop()?.toLowerCase();
    return ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'gif' || ext === 'webp';
  };

  const isAudioFile = (fileName?: string): boolean => {
    if (!fileName) return false;
    const ext = fileName.split('.').pop()?.toLowerCase();
    return ext === 'webm' || ext === 'mp3' || ext === 'wav' || ext === 'ogg';
  };

  // Периодическая попытка отправить файлы, если сеть есть
  useEffect(() => {
    if (isJoined) {
      retryIntervalRef.current = window.setInterval(() => {
        if (navigator.onLine) retryPendingFiles();
      }, 30000);
    }
    return () => {
      if (retryIntervalRef.current) clearInterval(retryIntervalRef.current);
    };
  }, [isJoined]);

  useEffect(() => {
    const handleOnline = () => retryPendingFiles();
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, []);

  // ----- Интерфейс -----
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
    <div style={{ display: 'flex', height: '100vh', flexDirection: 'column', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ padding: '10px', background: '#f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span>Чат: {username}</span>
        <span style={{ fontSize: '12px', color: isConnected ? 'green' : 'red' }}>{isConnected ? '● Онлайн' : '○ Офлайн'}</span>
        <button onClick={clearChat} style={{ background: '#dc3545', color: 'white', border: 'none', borderRadius: '20px', padding: '5px 12px', cursor: 'pointer' }}>
          Очистить чат
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px', background: '#fff' }}>
        {messages.map(msg => (
          <div key={msg.id} style={{
            marginBottom: '12px',
            textAlign: msg.username === username ? 'right' : 'left',
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            flexWrap: 'wrap',
            justifyContent: msg.username === username ? 'flex-end' : 'flex-start'
          }}>
            <div style={{
              background: msg.username === username ? '#dcf8c5' : '#fff',
              border: '1px solid #ddd',
              borderRadius: '12px',
              padding: '8px 12px',
              maxWidth: '70%',
              display: 'inline-block'
            }}>
              <div style={{ fontSize: '15px', fontWeight: 'bold', color: '#000', marginBottom: '4px' }}>
                {msg.username}
              </div>
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
              <div style={{ fontSize: '10px', color: '#aaa', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                {new Date(msg.timestamp).toLocaleTimeString()}
                {msg.username === username && (
                  <span style={{ fontSize: '12px' }}>
                    {msg.status === 'pending' ? '✓' : msg.status === 'sent' ? '✓✓' : ''}
                  </span>
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

      <div style={{ padding: '10px', background: '#f0f0f0', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSendText()}
          placeholder="Сообщение..."
          style={{ flex: 1, padding: '10px', borderRadius: '20px', border: '1px solid #ccc' }}
        />
        <button onClick={handleSendText} style={{ padding: '10px 20px', borderRadius: '20px', border: 'none', background: '#007bff', color: 'white' }}>➤</button>
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
            transition: 'background 0.2s'
          }}
        >
          {isRecording ? '🔴 Запись...' : '🎤'}
        </button>
      </div>
    </div>
  );
}