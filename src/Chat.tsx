import { useState, useEffect, useRef } from 'react';

interface Message {
  id: string;
  username: string;
  to?: string;
  text: string;
  isFile?: boolean;
  fileUrl?: string;
  fileName?: string;
  type?: string;
  timestamp: number;
  pending?: boolean;
  status?: string;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [username, setUsername] = useState('');
  const [users, setUsers] = useState<string[]>([]);
  const [selectedTo, setSelectedTo] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isJoined, setIsJoined] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pendingMessagesRef = useRef<Message[]>([]);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<number>();

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
      switch (data.type) {
        case 'userList':
  if (typeof data.text === 'string') {
    const usersArray = data.text.split(',');
    const filteredUsers = [];
    for (let i = 0; i < usersArray.length; i++) {
      const name = usersArray[i];
      if (name && name !== username) {
        filteredUsers.push(name);
      }
    }
    setUsers(filteredUsers);
  } else {
    setUsers([]);
  }
  break;
        case 'delete':
          setMessages(prev => prev.filter(m => m.id !== data.id));
          break;
        case 'ack':
          setMessages(prev => prev.map(m => m.id === data.id ? { ...m, pending: false, status: 'sent' } : m));
          pendingMessagesRef.current = pendingMessagesRef.current.filter(p => p.id !== data.id);
          break;
        case 'delivered':
          setMessages(prev => prev.map(m => m.id === data.id ? { ...m, status: 'delivered' } : m));
          break;
        case 'read':
          setMessages(prev => prev.map(m => m.id === data.id ? { ...m, status: 'read' } : m));
          break;
        case 'msg':
          setMessages(prev => [...prev, data]);
          break;
        default:
          if (data.type === '' || !data.type) {
            setMessages(prev => [...prev, data]);
          }
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

  // Авто-скролл вниз
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Отправка read для сообщений, адресованных текущему пользователю
  useEffect(() => {
    const unread = messages.filter(m => m.to === username && m.status !== 'read' && m.username !== username);
    unread.forEach(m => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'read', id: m.id }));
      }
    });
  }, [messages, username]);

  const sendMessage = (text: string, isFile = false, fileUrl = '', fileName = '') => {
    const msg: any = {
      id: Date.now().toString() + Math.random(),
      type: 'msg',
      username,
      text,
      isFile,
      fileUrl,
      fileName,
      to: selectedTo || '',
      timestamp: Date.now(),
      pending: true,
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

  const clearChat = async () => {
    if (confirm('Удалить всю историю чата?') && wsRef.current) {
      await fetch('/clear-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) });
      setMessages([]);
    }
  };

  const handleSendText = () => {
    if (input.trim() === '') return;
    sendMessage(input);
    setInput('');
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetch('/upload', { method: 'POST', body: formData });
      const downloadUrl = await response.text();
      sendMessage(`Файл: ${file.name}`, true, downloadUrl, file.name);
    } catch (err) {
      console.error(err);
      alert('Ошибка загрузки файла');
    }
  };

  const isImageFile = (fileUrl?: string): boolean => {
    if (!fileUrl) return false;
    const ext = fileUrl.split('.').pop()?.toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext || '');
  };

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
        <select value={selectedTo} onChange={e => setSelectedTo(e.target.value)} style={{ padding: '5px' }}>
          <option value="">Всем</option>
          {users.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <span style={{ fontSize: '12px', color: isConnected ? 'green' : 'red' }}>{isConnected ? '● Онлайн' : '○ Офлайн'}</span>
        <button onClick={clearChat} style={{ background: '#dc3545', color: 'white', border: 'none', borderRadius: '5px', padding: '5px 10px' }}>Очистить чат</button>
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
              display: 'inline-block',
              opacity: msg.pending ? 0.7 : 1
            }}>
              <div style={{ fontSize: '15px', fontWeight: 'bold', color: '#000', marginBottom: '4px' }}>
                {msg.username} {msg.to && msg.to !== username ? `→ ${msg.to}` : ''}
              </div>
              {msg.isFile ? (
                isImageFile(msg.fileUrl) ? (
                  <a href={msg.fileUrl} target="_blank" rel="noopener noreferrer">
                    <img src={msg.fileUrl} alt={msg.fileName} style={{ maxWidth: '200px', maxHeight: '200px', borderRadius: '8px' }} />
                  </a>
                ) : (
                  <a href={msg.fileUrl} target="_blank" rel="noopener noreferrer">{msg.text}</a>
                )
              ) : (
                <div>{msg.text}</div>
              )}
              <div style={{ fontSize: '10px', color: '#aaa', marginTop: '4px', display: 'flex', gap: '8px' }}>
                <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                {msg.pending ? <span>⌛</span> : (
                  msg.status === 'sent' ? <span>✓</span> :
                  msg.status === 'delivered' ? <span>✓✓</span> :
                  msg.status === 'read' ? <span style={{ color: '#4caf50' }}>✓✓</span> : null
                )}
              </div>
            </div>
            {msg.username === username && !msg.pending && (
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
      </div>
    </div>
  );
}