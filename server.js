const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Inicialização do Banco SQLite
const db = new sqlite3.Database('./vistorias_saaeb.db', (err) => {
  if (err) console.error('Erro ao conectar ao banco:', err.message);
  else console.log('Banco de dados SQLite conectado com sucesso.');
});

// Criação das Tabelas
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS vistorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      periodo TEXT NOT NULL,
      uc TEXT NOT NULL,
      endereco TEXT NOT NULL,
      bairro TEXT NOT NULL,
      motivo TEXT,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS bloqueios (
      data TEXT PRIMARY KEY
    )
  `);
});

// Rota: Obter dados de um dia específico
app.get('/api/dia/:data', (req, res) => {
  const { data } = req.params;

  db.get('SELECT data FROM bloqueios WHERE data = ?', [data], (err, bloqueio) => {
    if (err) return res.status(500).json({ error: err.message });

    db.all('SELECT * FROM vistorias WHERE data = ? ORDER BY CASE WHEN periodo = "manha" THEN 1 ELSE 2 END, id ASC', [data], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      res.json({
        data,
        bloqueado: !!bloqueio,
        vistorias: rows
      });
    });
  });
});

// Rota: Agendar Vistoria com Trava de Concorrência
app.post('/api/vistorias', (req, res) => {
  const { data, periodo, uc, endereco, bairro, motivo } = req.body;

  if (!data || !periodo || !uc || !endereco || !bairro) {
    return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser preenchidos.' });
  }

  // Verifica se o dia está bloqueado
  db.get('SELECT data FROM bloqueios WHERE data = ?', [data], (err, bloqueio) => {
    if (err) return res.status(500).json({ error: err.message });
    if (bloqueio) return res.status(400).json({ error: 'Este dia está bloqueado para agendamentos.' });

    // Verifica a contagem do período no banco
    db.get('SELECT COUNT(*) as total FROM vistorias WHERE data = ? AND periodo = ?', [data, periodo], (err, countRow) => {
      if (err) return res.status(500).json({ error: err.message });

      if (countRow.total >= 3) {
        return res.status(409).json({ error: 'Limite de 3 vistorias já atingido para este período!' });
      }

      const stmt = db.prepare('INSERT INTO vistorias (data, periodo, uc, endereco, bairro, motivo) VALUES (?, ?, ?, ?, ?, ?)');
      stmt.run([data, periodo, uc, endereco, bairro, motivo], function (err) {
        if (err) return res.status(500).json({ error: err.message });

        const novaVistoria = { id: this.lastID, data, periodo, uc, endereco, bairro, motivo };
        
        // Notifica todas as máquinas conectadas instantaneamente
        io.emit('atualizacao_agenda', { data });
        res.status(201).json(novaVistoria);
      });
    });
  });
});

// Rota: Excluir/Cancelar Vistoria
app.delete('/api/vistorias/:id', (req, res) => {
  const { id } = req.params;

  db.get('SELECT data FROM vistorias WHERE id = ?', [id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Vistoria não encontrada.' });

    const dataAfetada = row.data;
    db.run('DELETE FROM vistorias WHERE id = ?', [id], (err) => {
      if (err) return res.status(500).json({ error: err.message });

      io.emit('atualizacao_agenda', { data: dataAfetada });
      res.json({ message: 'Vistoria cancelada com sucesso.' });
    });
  });
});

// Rota: Alternar Bloqueio do Dia
app.post('/api/bloqueios/toggle', (req, res) => {
  const { data } = req.body;

  db.get('SELECT data FROM bloqueios WHERE data = ?', [data], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    if (row) {
      db.run('DELETE FROM bloqueios WHERE data = ?', [data], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('atualizacao_agenda', { data });
        res.json({ bloqueado: false });
      });
    } else {
      db.run('INSERT INTO bloqueios (data) VALUES (?)', [data], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('atualizacao_agenda', { data });
        res.json({ bloqueado: true });
      });
    }
  });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor SAAEB rodando na porta ${PORT}`);
  console.log(`Acesse localmente em: http://localhost:${PORT}`);
});