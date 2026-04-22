const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const cron = require('node-cron');
const { sendWechatNotification } = require('./notify');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== 数据库初始化 ==========
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:JrRHVqJXYOEvAbgvOEbxtQLjFuYvDozO@postgres.railway.internal:5432/railway',
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.app') ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS todos (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        date TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        kr_id INTEGER DEFAULT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TEXT,
        carried_from TEXT
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS subtasks (
        id SERIAL PRIMARY KEY,
        todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        parent_id INTEGER DEFAULT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS weekly_reports (
        id SERIAL PRIMARY KEY,
        week_start TEXT NOT NULL,
        week_end TEXT NOT NULL,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        week_num INTEGER NOT NULL,
        total_tasks INTEGER DEFAULT 0,
        completed_tasks INTEGER DEFAULT 0,
        total_subtasks INTEGER DEFAULT 0,
        completed_subtasks INTEGER DEFAULT 0,
        report_json TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(week_start, week_end)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS objectives (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS key_results (
        id SERIAL PRIMARY KEY,
        objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Init config
    await client.query(`INSERT INTO config (key, value) VALUES ('webhook_url', '') ON CONFLICT (key) DO NOTHING`);
    await client.query(`INSERT INTO config (key, value) VALUES ('tool_url', 'http://localhost:3000') ON CONFLICT (key) DO NOTHING`);
    console.log('[DB] PostgreSQL 初始化完成');
  } finally {
    client.release();
  }
}

// Helper: query shorthand
async function query(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}
async function queryOne(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows[0] || null;
}
async function run(sql, params = []) {
  const res = await pool.query(sql, params);
  return res;
}

// ========== 工具函数 ==========
function getTodayStr() {
  const now = new Date();
  const offset = 8 * 60; // UTC+8
  const local = new Date(now.getTime() + offset * 60000);
  return local.toISOString().split('T')[0];
}

function getYesterdayStr() {
  const now = new Date();
  const offset = 8 * 60;
  const local = new Date(now.getTime() + offset * 60000);
  local.setDate(local.getDate() - 1);
  return local.toISOString().split('T')[0];
}

async function getTodoWithSubtasks(todoId) {
  const todo = await queryOne('SELECT * FROM todos WHERE id = $1', [todoId]);
  if (!todo) return null;
  const allSubs = await query('SELECT * FROM subtasks WHERE todo_id = $1 ORDER BY sort_order ASC, id ASC', [todoId]);
  todo.subtasks = allSubs.filter(s => !s.parent_id).map(s => {
    s.children = allSubs.filter(c => c.parent_id === s.id);
    return s;
  });
  return todo;
}

async function getTodosWithSubtasks(date) {
  const todos = await query(`
    SELECT t.*, kr.content as kr_content, kr.objective_id, o.title as obj_title
    FROM todos t
    LEFT JOIN key_results kr ON t.kr_id = kr.id
    LEFT JOIN objectives o ON kr.objective_id = o.id
    WHERE t.date = $1
    ORDER BY t.completed ASC,
      (CASE WHEN t.carried_from IS NOT NULL AND t.completed = 0 THEN 0 ELSE 1 END) ASC,
      t.sort_order ASC, t.id ASC
  `, [date]);
  for (const t of todos) {
    const allSubs = await query('SELECT * FROM subtasks WHERE todo_id = $1 ORDER BY sort_order ASC, id ASC', [t.id]);
    t.subtasks = allSubs.filter(s => !s.parent_id).map(s => {
      s.children = allSubs.filter(c => c.parent_id === s.id);
      return s;
    });
  }
  return todos;
}

async function syncTodoCompleted(todoId) {
  const subtasks = await query('SELECT * FROM subtasks WHERE todo_id = $1', [todoId]);
  if (subtasks.length === 0) return;
  const allDone = subtasks.every(s => s.completed);
  const todo = await queryOne('SELECT * FROM todos WHERE id = $1', [todoId]);
  if (!todo) return;
  if (allDone && !todo.completed) {
    await run('UPDATE todos SET completed = 1, completed_at = $1 WHERE id = $2', [new Date().toISOString(), todoId]);
  } else if (!allDone && todo.completed) {
    await run('UPDATE todos SET completed = 0, completed_at = NULL WHERE id = $1', [todoId]);
  }
}

async function syncParentSubtask(subtaskId) {
  const sub = await queryOne('SELECT * FROM subtasks WHERE id = $1', [subtaskId]);
  if (!sub) return;
  if (sub.parent_id) {
    const siblings = await query('SELECT * FROM subtasks WHERE parent_id = $1', [sub.parent_id]);
    if (siblings.length > 0) {
      const allDone = siblings.every(s => s.completed);
      const parent = await queryOne('SELECT * FROM subtasks WHERE id = $1', [sub.parent_id]);
      if (parent) {
        if (allDone && !parent.completed) {
          await run('UPDATE subtasks SET completed = 1 WHERE id = $1', [sub.parent_id]);
        } else if (!allDone && parent.completed) {
          await run('UPDATE subtasks SET completed = 0 WHERE id = $1', [sub.parent_id]);
        }
      }
    }
  }
  const children = await query('SELECT * FROM subtasks WHERE parent_id = $1', [subtaskId]);
  if (children.length > 0) {
    const allChildrenDone = children.every(c => c.completed);
    if (allChildrenDone && !sub.completed) {
      await run('UPDATE subtasks SET completed = 1 WHERE id = $1', [subtaskId]);
    } else if (!allChildrenDone && sub.completed) {
      await run('UPDATE subtasks SET completed = 0 WHERE id = $1', [subtaskId]);
    }
  }
}

async function getToolUrl() {
  const row = await queryOne('SELECT value FROM config WHERE key = $1', ['tool_url']);
  return row ? row.value : 'http://localhost:3000';
}

function getWeekRange(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMon);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: monday.toISOString().split('T')[0], end: sunday.toISOString().split('T')[0] };
}

function getWeekNumber(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

// ========== API: Todos ==========

app.get('/api/todos', async (req, res) => {
  try {
    const date = req.query.date || getTodayStr();
    if (date === getTodayStr()) await carryOverTasks();
    const data = await getTodosWithSubtasks(date);
    res.json({ success: true, data, date });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/todos', async (req, res) => {
  try {
    const { content, date } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ success: false, message: '内容不能为空' });
    const targetDate = date || getTodayStr();
    const maxOrder = await queryOne('SELECT MAX(sort_order) as m FROM todos WHERE date = $1', [targetDate]);
    const order = (maxOrder.m || 0) + 1;
    const result = await queryOne('INSERT INTO todos (content, date, sort_order) VALUES ($1, $2, $3) RETURNING id', [content.trim(), targetDate, order]);
    res.json({ success: true, data: await getTodoWithSubtasks(result.id) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.patch('/api/todos/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const todo = await queryOne('SELECT * FROM todos WHERE id = $1', [id]);
    if (!todo) return res.status(404).json({ success: false, message: 'Todo 不存在' });
    const newCompleted = todo.completed ? 0 : 1;
    await run('UPDATE todos SET completed = $1, completed_at = $2 WHERE id = $3', [newCompleted, newCompleted ? new Date().toISOString() : null, id]);
    await run('UPDATE subtasks SET completed = $1 WHERE todo_id = $2', [newCompleted, id]);
    res.json({ success: true, data: await getTodoWithSubtasks(id) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.patch('/api/todos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { content, kr_id } = req.body;
    if (content !== undefined) {
      if (!content.trim()) return res.status(400).json({ success: false, message: '内容不能为空' });
      await run('UPDATE todos SET content = $1 WHERE id = $2', [content.trim(), id]);
    }
    if (kr_id !== undefined) await run('UPDATE todos SET kr_id = $1 WHERE id = $2', [kr_id, id]);
    res.json({ success: true, data: await getTodoWithSubtasks(id) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.patch('/api/todos/:id/link-kr', async (req, res) => {
  try {
    const { id } = req.params;
    const { kr_id } = req.body;
    await run('UPDATE todos SET kr_id = $1 WHERE id = $2', [kr_id || null, id]);
    res.json({ success: true, data: await getTodoWithSubtasks(id) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/todos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await run('DELETE FROM subtasks WHERE todo_id = $1', [id]);
    await run('DELETE FROM todos WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/todos/reorder', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ success: false });
    for (let i = 0; i < ids.length; i++) await run('UPDATE todos SET sort_order = $1 WHERE id = $2', [i, ids[i]]);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/subtasks/reorder', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ success: false });
    for (let i = 0; i < ids.length; i++) await run('UPDATE subtasks SET sort_order = $1 WHERE id = $2', [i, ids[i]]);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

// ========== API: Subtasks ==========

app.post('/api/todos/:todoId/subtasks', async (req, res) => {
  try {
    const { todoId } = req.params;
    const { content, parent_id } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ success: false, message: '内容不能为空' });
    const todo = await queryOne('SELECT * FROM todos WHERE id = $1', [todoId]);
    if (!todo) return res.status(404).json({ success: false, message: 'Todo 不存在' });
    const maxOrder = await queryOne('SELECT MAX(sort_order) as m FROM subtasks WHERE todo_id = $1 AND (parent_id IS NOT DISTINCT FROM $2)', [todoId, parent_id || null]);
    await run('INSERT INTO subtasks (todo_id, content, sort_order, parent_id) VALUES ($1, $2, $3, $4)', [todoId, content.trim(), (maxOrder.m || 0) + 1, parent_id || null]);
    if (todo.completed) await run('UPDATE todos SET completed = 0, completed_at = NULL WHERE id = $1', [todoId]);
    res.json({ success: true, data: await getTodoWithSubtasks(todoId) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.patch('/api/subtasks/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const sub = await queryOne('SELECT * FROM subtasks WHERE id = $1', [id]);
    if (!sub) return res.status(404).json({ success: false, message: '子任务不存在' });
    await run('UPDATE subtasks SET completed = $1 WHERE id = $2', [sub.completed ? 0 : 1, id]);
    await syncParentSubtask(parseInt(id));
    await syncTodoCompleted(sub.todo_id);
    res.json({ success: true, data: await getTodoWithSubtasks(sub.todo_id) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.patch('/api/subtasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ success: false, message: '内容不能为空' });
    const sub = await queryOne('SELECT * FROM subtasks WHERE id = $1', [id]);
    if (!sub) return res.status(404).json({ success: false, message: '子任务不存在' });
    await run('UPDATE subtasks SET content = $1 WHERE id = $2', [content.trim(), id]);
    res.json({ success: true, data: await getTodoWithSubtasks(sub.todo_id) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/subtasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sub = await queryOne('SELECT * FROM subtasks WHERE id = $1', [id]);
    if (!sub) return res.status(404).json({ success: false, message: '子任务不存在' });
    const todoId = sub.todo_id;
    const parentId = sub.parent_id;
    await run('DELETE FROM subtasks WHERE parent_id = $1', [id]);
    await run('DELETE FROM subtasks WHERE id = $1', [id]);
    if (parentId) await syncParentSubtask(parentId);
    await syncTodoCompleted(todoId);
    res.json({ success: true, data: await getTodoWithSubtasks(todoId) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

// ========== API: OKR ==========

app.get('/api/okr/all-krs', async (req, res) => {
  try {
    const krs = await query(`
      SELECT kr.id, kr.content, kr.progress, kr.objective_id, o.title as objective_title
      FROM key_results kr JOIN objectives o ON kr.objective_id = o.id
      ORDER BY o.sort_order ASC, o.id ASC, kr.sort_order ASC, kr.id ASC
    `);
    res.json({ success: true, data: krs });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

async function getObjectiveWithKRs(objId) {
  const obj = await queryOne('SELECT * FROM objectives WHERE id = $1', [objId]);
  if (!obj) return null;
  obj.key_results = await query('SELECT * FROM key_results WHERE objective_id = $1 ORDER BY sort_order ASC, id ASC', [objId]);
  return obj;
}

async function getAllOKRs() {
  const objs = await query('SELECT * FROM objectives ORDER BY sort_order ASC, id ASC');
  for (const o of objs) {
    o.key_results = await query('SELECT * FROM key_results WHERE objective_id = $1 ORDER BY sort_order ASC, id ASC', [o.id]);
  }
  return objs;
}

app.get('/api/okr', async (req, res) => {
  try { res.json({ success: true, data: await getAllOKRs() }); }
  catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/okr/objectives', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ success: false, message: '目标不能为空' });
    const maxOrder = await queryOne('SELECT MAX(sort_order) as m FROM objectives');
    const result = await queryOne('INSERT INTO objectives (title, sort_order) VALUES ($1, $2) RETURNING id', [title.trim(), (maxOrder.m || 0) + 1]);
    res.json({ success: true, data: await getObjectiveWithKRs(result.id) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.patch('/api/okr/objectives/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ success: false, message: '目标不能为空' });
    await run('UPDATE objectives SET title = $1 WHERE id = $2', [title.trim(), id]);
    res.json({ success: true, data: await getObjectiveWithKRs(id) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/okr/objectives/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await run('DELETE FROM key_results WHERE objective_id = $1', [id]);
    await run('DELETE FROM objectives WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/okr/objectives/:objId/kr', async (req, res) => {
  try {
    const { objId } = req.params;
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ success: false, message: 'KR 不能为空' });
    const obj = await queryOne('SELECT * FROM objectives WHERE id = $1', [objId]);
    if (!obj) return res.status(404).json({ success: false, message: '目标不存在' });
    const maxOrder = await queryOne('SELECT MAX(sort_order) as m FROM key_results WHERE objective_id = $1', [objId]);
    await run('INSERT INTO key_results (objective_id, content, sort_order) VALUES ($1, $2, $3)', [objId, content.trim(), (maxOrder.m || 0) + 1]);
    res.json({ success: true, data: await getObjectiveWithKRs(objId) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.patch('/api/okr/kr/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { content, progress } = req.body;
    const kr = await queryOne('SELECT * FROM key_results WHERE id = $1', [id]);
    if (!kr) return res.status(404).json({ success: false, message: 'KR 不存在' });
    if (content !== undefined) await run('UPDATE key_results SET content = $1 WHERE id = $2', [content.trim(), id]);
    if (progress !== undefined) await run('UPDATE key_results SET progress = $1 WHERE id = $2', [Math.max(0, Math.min(100, parseInt(progress))), id]);
    res.json({ success: true, data: await getObjectiveWithKRs(kr.objective_id) });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/okr/kr/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const kr = await queryOne('SELECT * FROM key_results WHERE id = $1', [id]);
    if (!kr) return res.status(404).json({ success: false, message: 'KR 不存在' });
    await run('DELETE FROM key_results WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/okr/kr/:id/to-todo', async (req, res) => {
  try {
    const { id } = req.params;
    const { date } = req.body;
    const kr = await queryOne('SELECT kr.*, o.title as obj_title FROM key_results kr JOIN objectives o ON kr.objective_id = o.id WHERE kr.id = $1', [id]);
    if (!kr) return res.status(404).json({ success: false, message: 'KR 不存在' });
    const targetDate = date || getTodayStr();
    const exists = await queryOne('SELECT id FROM todos WHERE kr_id = $1 AND date = $2', [kr.id, targetDate]);
    if (exists) return res.json({ success: false, message: '待办中已存在该 KR' });
    const maxOrder = await queryOne('SELECT MAX(sort_order) as m FROM todos WHERE date = $1', [targetDate]);
    const result = await queryOne('INSERT INTO todos (content, date, sort_order, kr_id) VALUES ($1, $2, $3, $4) RETURNING id', [kr.content, targetDate, (maxOrder.m || 0) + 1, kr.id]);
    res.json({ success: true, message: '已添加到待办', todoId: result.id });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

// ========== API: Weekly Reports ==========

app.get('/api/reports/weekly-gantt', async (req, res) => {
  try {
    const date = req.query.date || getTodayStr();
    const { start, end } = getWeekRange(date);
    const days = [];
    const cur = new Date(start + 'T00:00:00');
    const endDate = new Date(end + 'T00:00:00');
    while (cur <= endDate) { days.push(cur.toISOString().split('T')[0]); cur.setDate(cur.getDate() + 1); }

    const taskMap = new Map();
    for (const dateStr of days) {
      const todos = await getTodosWithSubtasks(dateStr);
      todos.forEach(t => {
        const isKR = !!t.kr_id;
        if (isKR) {
          (t.subtasks || []).forEach(s => {
            if (s.completed) {
              const key = `kr:${t.content}:${s.content}`;
              if (!taskMap.has(key)) taskMap.set(key, { content: s.content, krName: t.content, days: new Set(), subtasks: [], isKR: true });
              taskMap.get(key).days.add(dateStr);
              const existing = taskMap.get(key);
              (s.children || []).forEach(c => { if (c.completed && !existing.subtasks.find(x => x.content === c.content)) existing.subtasks.push({ content: c.content }); });
            }
          });
        } else if (t.completed) {
          const key = t.content;
          if (!taskMap.has(key)) taskMap.set(key, { content: t.content, days: new Set(), subtasks: [], isKR: false });
          taskMap.get(key).days.add(dateStr);
          const existing = taskMap.get(key);
          (t.subtasks || []).forEach(s => {
            if (s.completed && !existing.subtasks.find(x => x.content === s.content)) existing.subtasks.push({ content: s.content });
            (s.children || []).forEach(c => { if (c.completed && !existing.subtasks.find(x => x.content === c.content)) existing.subtasks.push({ content: c.content }); });
          });
        }
      });
    }

    const tasks = Array.from(taskMap.values()).map(t => ({
      content: t.content, krName: t.krName || null, isKR: t.isKR,
      days: Array.from(t.days).sort(), startDate: Array.from(t.days).sort()[0],
      endDate: Array.from(t.days).sort().pop(), dayCount: t.days.size, subtasks: t.subtasks
    }));

    res.json({ success: true, data: { weekStart: start, weekEnd: end, weekDays: days, weekNum: getWeekNumber(start), tasks, totalCompleted: tasks.length } });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

// ========== Config ==========

app.get('/api/config', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM config');
    const config = {};
    rows.forEach(r => { config[r.key] = r.value; });
    res.json({ success: true, data: config });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/config', async (req, res) => {
  try {
    const { webhook_url, tool_url } = req.body;
    if (webhook_url !== undefined) await run('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', ['webhook_url', webhook_url]);
    if (tool_url !== undefined) await run('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', ['tool_url', tool_url]);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/notify/test', async (req, res) => {
  const { type } = req.body;
  try {
    if (type === 'morning') await morningNotify();
    else await eveningNotify();
    res.json({ success: true, message: '通知已发送' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/carry-over', async (req, res) => {
  try {
    const count = await carryOverTasks();
    res.json({ success: true, message: `已累积 ${count} 个未完成任务到今天` });
  } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

// ========== 通知逻辑 ==========
async function getWebhookUrl() {
  const row = await queryOne('SELECT value FROM config WHERE key = $1', ['webhook_url']);
  return row ? row.value : '';
}

async function morningNotify() {
  const webhookUrl = await getWebhookUrl();
  if (!webhookUrl) { console.log('[通知] Webhook URL 未配置'); return; }
  const carriedCount = await carryOverTasks();
  const today = getTodayStr();
  const todos = await getTodosWithSubtasks(today);
  const toolUrl = await getToolUrl();
  const pending = todos.filter(t => !t.completed);
  let content = `## 📋 项目管理早间提醒\n\n`;
  content += `今日共有 **${todos.length}** 项待办`;
  if (carriedCount > 0) content += `，其中 **${carriedCount}** 项为昨日遗留`;
  content += `\n\n`;
  if (pending.length > 0) { pending.forEach((t, i) => { content += `${i + 1}. ${t.content}${t.carried_from ? ' 🔴' : ''}\n`; }); content += '\n'; }
  content += `[👉 打开项目管理](${toolUrl})`;
  await sendWechatNotification(webhookUrl, { msgtype: 'markdown', markdown: { content } });
  console.log(`[通知] 早间提醒已发送 (${today})`);
}

async function eveningNotify() {
  const webhookUrl = await getWebhookUrl();
  if (!webhookUrl) { console.log('[通知] Webhook URL 未配置'); return; }
  const today = getTodayStr();
  const todos = await getTodosWithSubtasks(today);
  const toolUrl = await getToolUrl();
  const completed = todos.filter(t => t.completed);
  const uncompleted = todos.filter(t => !t.completed);
  let content = `## 📊 项目管理日终总结\n\n`;
  content += `今日待办 **${todos.length}** 项，已完成 **${completed.length}** 项`;
  if (uncompleted.length > 0) content += `，未完成 **${uncompleted.length}** 项`;
  content += `\n\n`;
  if (uncompleted.length > 0) {
    content += `### 未完成任务\n`;
    uncompleted.forEach((t, i) => { content += `${i + 1}. ${t.content}\n`; });
    content += `\n> ⚠️ 以上任务将自动累积到明天\n\n`;
  } else { content += `🎉 **恭喜！今天的任务全部完成！**\n\n`; }
  content += `[👉 打开项目管理](${toolUrl})`;
  await sendWechatNotification(webhookUrl, { msgtype: 'markdown', markdown: { content } });
  console.log(`[通知] 日终总结已发送 (${today})`);
}

// ========== 未完成任务累积 ==========
async function carryOverTasks() {
  const today = getTodayStr();
  const yesterday = getYesterdayStr();
  const uncompletedYesterday = await query('SELECT * FROM todos WHERE date = $1 AND completed = 0', [yesterday]);
  let carriedCount = 0;

  for (const todo of uncompletedYesterday) {
    const exists = await queryOne('SELECT id FROM todos WHERE date = $1 AND content = $2 AND carried_from = $3', [today, todo.content, yesterday]);
    if (exists) continue;
    if (todo.kr_id) {
      const krExists = await queryOne('SELECT id FROM todos WHERE date = $1 AND kr_id = $2', [today, todo.kr_id]);
      if (krExists) continue;
    }

    const result = await queryOne('INSERT INTO todos (content, date, carried_from, sort_order, kr_id) VALUES ($1, $2, $3, $4, $5) RETURNING id', [todo.content, today, yesterday, todo.sort_order || 0, todo.kr_id || null]);
    const newTodoId = result.id;

    const topSubs = await query('SELECT * FROM subtasks WHERE todo_id = $1 AND parent_id IS NULL ORDER BY sort_order ASC, id ASC', [todo.id]);
    for (const s of topSubs) {
      const subResult = await queryOne('INSERT INTO subtasks (todo_id, content, completed, sort_order, parent_id) VALUES ($1, $2, $3, $4, NULL) RETURNING id', [newTodoId, s.content, s.completed ? 1 : 0, s.sort_order]);
      const newSubId = subResult.id;
      const children = await query('SELECT * FROM subtasks WHERE parent_id = $1 ORDER BY sort_order ASC, id ASC', [s.id]);
      for (const c of children) {
        await run('INSERT INTO subtasks (todo_id, content, completed, sort_order, parent_id) VALUES ($1, $2, $3, $4, $5)', [newTodoId, c.content, c.completed ? 1 : 0, c.sort_order, newSubId]);
      }
    }

    await run('UPDATE todos SET completed = 1, completed_at = $1 WHERE id = $2', [new Date().toISOString(), todo.id]);
    carriedCount++;
  }
  if (carriedCount > 0) console.log(`[累积] ${yesterday} → ${today}: ${carriedCount} 个任务`);
  return carriedCount;
}

// ========== 定时任务 ==========
cron.schedule('30 9 * * *', () => { morningNotify().catch(err => console.error('[定时] 早间提醒失败:', err)); });
cron.schedule('30 17 * * *', () => { eveningNotify().catch(err => console.error('[定时] 日终总结失败:', err)); });

console.log('[定时] 已注册: 09:30 早间提醒, 17:30 日终总结');

// ========== 启动 ==========
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 项目管理服务已启动`);
    console.log(`📍 访问地址: http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
