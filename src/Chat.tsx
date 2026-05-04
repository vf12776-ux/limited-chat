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
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [username, setUsername] = useState('');
  const [users, setUsers] = useState<string[]>([]);
  const [selectedTo, setSelectedTo] = useState(''); // '' = всем
  const [isConnected, setIsConnected] = useState(false);
  const [isJoined, setIsJoined] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const joinChat = () => {
    if (!username.trim()) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WS connected');
      // Отправляем приветственное сообщение с именем
      ws.send(JSON.stringify({ type: 'hello', username }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('Message from server:', data);
      if (data.type === 'userList') {
        setUsers(data.text.split(',').filter((u: string) => u !== username));
      } else if (data.type === 'delete') {
        setMessages(prev => prev.filter(m => m.id !== data.id));
      } else if (data.type === 'msg' || data.type === '') {
        setMessages(prev => [...prev, data]);
      } else if (data.type === 'error') {
        alert(data.text);
      }
    };

    ws.onclose = () => {
      console.log('WS closed');
      setIsConnected(false);
    };

    setIsConnected(true);
    setIsJoined(true);
  };

  const sendMessage = (text: string, isFile = false, fileUrl = '', fileName = '') => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      alert('Нет соединения с сервером');
      return;
    }
    const msg: any = {
      type: 'msg',
      username,
      text,
      isFile,
      fileUrl,
      fileName,
      to: selectedTo || '',
      timestamp: Date.now(),
    };
    wsRef.current.send(JSON.stringify(msg));
  };

  const deleteMessage = (id: string) => {
    if (!wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'delete', id }));
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

  if (!isJoined) {
    return (
      <div style={{ maxWidth: '400px', margin: '50px auto', textAlign: 'center' }}>
        <h2>P2P Messenger</h2>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Ваше имя"
          style={{ padding: '10px', width: '80%', marginBottom: '10px' }}
        />
        <button onClick={joinChat} style={{ padding: '10px 20px' }}>Войти</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100vh', flexDirection: 'column', maxWidth: '1200px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ padding: '10px', background: '#f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Чат: {username}</span>
        <select value={selectedTo} onChange={e => setSelectedTo(e.target.value)} style={{ padding: '5px' }}>
          <option value="">Всем</option>
          {users.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <span style={{ fontSize: '12px', color: isConnected ? 'green' : 'red' }}>
          {isConnected ? '● Онлайн' : '○ Офлайн'}
        </span>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px', background: '#fff' }}>
        {messages.map((msg) => (
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
              <div style={{ fontSize: '12px', color: '#555', marginBottom: '4px' }}>
                {msg.username} {msg.to && msg.to !== username ? `→ ${msg.to}` : ''}
              </div>
              {msg.isFile ? (
                <a href={msg.fileUrl} target="_blank" rel="noopener noreferrer">{msg.text}</a>
              ) : (
                <div>{msg.text}</div>
              )}
              <div style={{ fontSize: '10px', color: '#aaa', marginTop: '4px' }}>
                {new Date(msg.timestamp).toLocaleTimeString()}
              </div>
            </div>
            {msg.username === username && (
              <button onClick={() => deleteMessage(msg.id)} style={{ background: 'none', border: 'none', color: 'red', cursor: 'pointer', fontSize: '16px' }}>🗑️</button>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{ padding: '10px', background: '#f0f0f0', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSendText()}
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