
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;

const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

const players = new Map();
const MAX_HEALTH = 100;

app.use(express.json());
app.use(express.static(__dirname));

app.get('/health', (_req, res) =>
  res.json({ ok: true, players: players.size })
);

app.get('/api/jogadores', async (_req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase não configurado' });
  }

  const { data, error } = await supabase
    .from('jogadores')
    .select('id, nome, skins');

  if (error) {
    console.error('Erro Supabase:', error.message);
    return res.status(500).json({ error: 'Não foi possível consultar jogadores' });
  }

  res.json(data);
});

function cleanName(v) {
  return String(v || 'Jogador')
    .replace(/[<>\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 18) || 'Jogador';
}

function publicPlayer(p) {
  return {
    id: p.id, name: p.name,
    x: p.x, y: p.y, z: p.z,
    dx: p.dx, dy: p.dy, dz: p.dz,
    health: p.health, score: p.score
  };
}

function finite(v, fallback = 0) {
  return Number.isFinite(Number(v)) ? Number(v) : fallback;
}

io.on('connection', socket => {
  const p = {
    id: socket.id, name: 'Jogador',
    x: 0, y: 0, z: 0,
    dx: 0, dy: 0, dz: -1,
    health: MAX_HEALTH, score: 0
  };

  players.set(socket.id, p);

  socket.emit('online:init', {
    id: socket.id,
    players: [...players.values()]
      .filter(q => q.id !== socket.id)
      .map(publicPlayer),
    self: publicPlayer(p)
  });

  socket.broadcast.emit('online:join', publicPlayer(p));

  socket.on('online:name', name => {
    p.name = cleanName(name);
    io.emit('online:update', publicPlayer(p));
  });

  socket.on('online:move', data => {
    if (!data || typeof data !== 'object') return;

    p.x = Math.max(-500, Math.min(500, finite(data.x, p.x)));
    p.y = Math.max(-20, Math.min(100, finite(data.y, p.y)));
    p.z = Math.max(-500, Math.min(500, finite(data.z, p.z)));
    p.dx = finite(data.dx, p.dx);
    p.dy = finite(data.dy, p.dy);
    p.dz = finite(data.dz, p.dz);

    socket.broadcast.volatile.emit('online:move', publicPlayer(p));
  });

  socket.on('online:respawn', () => {
    p.health = MAX_HEALTH;
    p.y = 0;
    io.emit('online:update', publicPlayer(p));
  });

  socket.on('online:shoot', shot => {
    if (!shot || typeof shot !== 'object' || p.health <= 0) return;

    const ox = finite(shot.x, p.x);
    const oy = finite(shot.y, p.y + 1.4);
    const oz = finite(shot.z, p.z);

    let dx = finite(shot.dx, p.dx);
    let dy = finite(shot.dy, p.dy);
    let dz = finite(shot.dz, p.dz);

    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;

    let victim = null;
    let best = Infinity;

    for (const q of players.values()) {
      if (q.id === p.id || q.health <= 0) continue;

      const vx = q.x - ox;
      const vy = q.y + 1 - oy;
      const vz = q.z - oz;
      const along = vx * dx + vy * dy + vz * dz;

      if (along < 0 || along > 120) continue;

      const perpendicular = Math.hypot(
        vx - dx * along,
        vy - dy * along,
        vz - dz * along
      );

      if (perpendicular < 1.25 && along < best) {
        best = along;
        victim = q;
      }
    }

    if (victim) {
      victim.health = Math.max(
        0,
        victim.health - Math.max(1, Math.min(100, finite(shot.damage, 25)))
      );

      if (victim.health === 0) {
        p.score += 1;
        io.to(p.id).emit('online:kill', {
          name: victim.name,
          score: p.score
        });
      }

      io.emit('online:update', publicPlayer(victim));
      io.to(victim.id).emit('online:hit', {
        health: victim.health,
        by: p.name
      });
    }

    io.emit('online:shot', {
      id: p.id, x: ox, y: oy, z: oz,
      dx, dy, dz, hit: victim ? victim.id : null
    });
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    io.emit('online:leave', socket.id);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor online na porta ${PORT}`);
});
