import React, { useState } from 'react';
import Chat from './Chat';

const App: React.FC = () => {
  const [username, setUsername] = useState<string | null>(null);
  const [inputName, setInputName] = useState('');

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputName.trim()) {
      setUsername(inputName.trim());
    }
  };

  if (!username) {
    return (
      <div className="login-container">
        <div className="login-box">
          <h1>Мессенджер</h1>
          <form onSubmit={handleJoin}>
            <input
              type="text"
              placeholder="Введите ваше имя"
              value={inputName}
              onChange={(e) => setInputName(e.target.value)}
              autoFocus
            />
            <button type="submit">Войти</button>
          </form>
        </div>
      </div>
    );
  }

  return <Chat username={username} />;
};

export default App;