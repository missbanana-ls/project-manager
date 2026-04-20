const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const { sendWechatNotification } = require('./notify');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== 数据库初始化 ==========
const db = new Database(path.join(__dirname, 'todos.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    date TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    completed_at TEXT,
    carried_from TEXT
  )
`);
try { db.exec('ALTER TABLE todos ADD COLUMN sort_order INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE todos ADD COLUMN kr_id INTEGER DEFAULT NULL'); } catch(e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS subtasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    parent_id INTEGER DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
  )
`);
try { db.exec('ALTER TABLE subtasks ADD COLUMN parent_id INTEGER DEFAULT NULL'); } catch(e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS weekly_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(week_start, week_end)
  )
`);

const initConfig = db.prepare(`INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)`);
initConfig.run('webhook_url', '');
initConfig.run('tool_url', 'http://localhost:3000');

db.exec(`
  CREATE TABLE IF NOT EXISTS objectives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS key_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    objective_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE
  )
`);

// ========== 工具函数 ==========
function getTodayStr() {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

function getYesterdayStr() {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  return now.toISOString().split('T')[0];
}

function getTodoWithSubtasks(todoId) {
  const todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(todoId);
  if (!todo) return null;
  const allSubs = db.prepare('SELECT * FROM subtasks WHERE todo_id = ? ORDER BY sort_order ASC, id ASC').all(todoId);
  // Build tree: top-level (parent_id IS NULL) with children
  todo.subtasks = allSubs.filter(s => !s.parent_id).map(s => {
    s.children = allSubs.filter(c => c.parent_id === s.id);
    return s;
  });
  return todo;
}

function getTodosWithSubtasks(date) {
  const todos = db.prepare(`
    SELECT t.*, kr.content as kr_content, kr.objective_id, o.title as obj_title
    FROM todos t
    LEFT JOIN key_results kr ON t.kr_id = kr.id
    LEFT JOIN objectives o ON kr.objective_id = o.id
    WHERE t.date = ?
    ORDER BY t.completed ASC,
      (CASE WHEN t.carried_from IS NOT NULL AND t.completed = 0 THEN 0 ELSE 1 END) ASC,
      t.sort_order ASC, t.id ASC
  `).all(date);
  const subtaskStmt = db.prepare('SELECT * FROM subtasks WHERE todo_id = ? ORDER BY sort_order ASC, id ASC');
  return todos.map(t => {
    const allSubs = subtaskStmt.all(t.id);
    t.subtasks = allSubs.filter(s => !s.parent_id).map(s => {
      s.children = allSubs.filter(c => c.parent_id === s.id);
      return s;
    });
    return t;
  });
}

function syncTodoCompleted(todoId) {
  const subtasks = db.prepare('SELECT * FROM subtasks WHERE todo_id = ?').all(todoId);
  if (subtasks.length === 0) return;
  const allDone = subtasks.every(s => s.completed);
  const todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(todoId);
  if (!todo) return;
  if (allDone && !todo.completed) {
    db.prepare('UPDATE todos SET completed = 1, completed_at = ? WHERE id = ?').run(new Date().toISOString(), todoId);
  } else if (!allDone && todo.completed) {
    db.prepare('UPDATE todos SET completed = 0, completed_at = NULL WHERE id = ?').run(todoId);
  }
}

// Sync parent subtask completion: if all children of a parent subtask are done, mark parent done too
function syncParentSubtask(subtaskId) {
  // Re-read the subtask to get latest state
  const sub = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(subtaskId);
  if (!sub) return;
  
  // If this subtask has a parent_id, check if all siblings under that parent are done
  if (sub.parent_id) {
    const siblings = db.prepare('SELECT * FROM subtasks WHERE parent_id = ?').all(sub.parent_id);
    if (siblings.length > 0) {
      const allDone = siblings.every(s => s.completed);
      const parent = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(sub.parent_id);
      if (parent) {
        if (allDone && !parent.completed) {
          db.prepare('UPDATE subtasks SET completed = 1 WHERE id = ?').run(sub.parent_id);
        } else if (!allDone && parent.completed) {
          db.prepare('UPDATE subtasks SET completed = 0 WHERE id = ?').run(sub.parent_id);
        }
      }
    }
  }
  
  // Also check: if this subtask IS a parent (has children), sync its own status based on children
  const children = db.prepare('SELECT * FROM subtasks WHERE parent_id = ?').all(subtaskId);
  if (children.length > 0) {
    const allChildrenDone = children.every(c => c.completed);
    if (allChildrenDone && !sub.completed) {
      db.prepare('UPDATE subtasks SET completed = 1 WHERE id = ?').run(subtaskId);
    } else if (!allChildrenDone && sub.completed) {
      db.prepare('UPDATE subtasks SET completed = 0 WHERE id = ?').run(subtaskId);
    }
  }
}

function getToolUrl() {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get('tool_url');
  return row ? row.value : 'http://localhost:3000';
}

// 获取某日期所在周的周一和周日
function getWeekRange(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMon);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    start: monday.toISOString().split('T')[0],
    end: sunday.toISOString().split('T')[0]
  };
}

// 获取 ISO 周数
function getWeekNumber(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

// 生成周报
function generateWeeklyReport(weekStart, weekEnd) {
  // 检查是否已存在
  const existing = db.prepare('SELECT id FROM weekly_reports WHERE week_start = ? AND week_end = ?').get(weekStart, weekEnd);
  if (existing) return existing.id;

  // 获取这周每天的 todos
  const days = [];
  const cur = new Date(weekStart + 'T00:00:00');
  const endDate = new Date(weekEnd + 'T00:00:00');
  while (cur <= endDate) {
    const dateStr = cur.toISOString().split('T')[0];
    const todos = getTodosWithSubtasks(dateStr);
    if (todos.length > 0) {
      days.push({ date: dateStr, todos });
    }
    cur.setDate(cur.getDate() + 1);
  }

  // 统计
  let totalTasks = 0, completedTasks = 0, totalSubs = 0, completedSubs = 0;
  const dailySummary = [];

  days.forEach(day => {
    const completed = day.todos.filter(t => t.completed);
    const pending = day.todos.filter(t => !t.completed);
    let daySubs = 0, daySubsDone = 0;
    day.todos.forEach(t => {
      daySubs += t.subtasks.length;
      daySubsDone += t.subtasks.filter(s => s.completed).length;
    });

    totalTasks += day.todos.length;
    completedTasks += completed.length;
    totalSubs += daySubs;
    completedSubs += daySubsDone;

    dailySummary.push({
      date: day.date,
      total: day.todos.length,
      completed: completed.length,
      pending: pending.length,
      tasks: day.todos.map(t => ({
        content: t.content,
        completed: !!t.completed,
        subtasks: t.subtasks.map(s => ({ content: s.content, completed: !!s.completed }))
      }))
    });
  });

  const report = { weekStart, weekEnd, dailySummary, totalTasks, completedTasks, totalSubs, completedSubs };

  const startD = new Date(weekStart + 'T00:00:00');
  const month = startD.getMonth() + 1;
  const year = startD.getFullYear();
  const weekNum = getWeekNumber(weekStart);

  db.prepare(`
    INSERT INTO weekly_reports (week_start, week_end, year, month, week_num, total_tasks, completed_tasks, total_subtasks, completed_subtasks, report_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(weekStart, weekEnd, year, month, weekNum, totalTasks, completedTasks, totalSubs, completedSubs, JSON.stringify(report));

  const inserted = db.prepare('SELECT id FROM weekly_reports WHERE week_start = ? AND week_end = ?').get(weekStart, weekEnd);
  console.log(`[周报] 已生成周报: ${weekStart} ~ ${weekEnd} (第${weekNum}周)`);
  return inserted.id;
}

// ========== API: Todos ==========

app.get('/api/todos', (req, res) => {
  const date = req.query.date || getTodayStr();
  const data = getTodosWithSubtasks(date);
  res.json({ success: true, data, date });
});

app.post('/api/todos', (req, res) => {
  const { content, date } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ success: false, message: '内容不能为空' });
  const targetDate = date || getTodayStr();
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM todos WHERE date = ?').get(targetDate);
  const order = (maxOrder.m || 0) + 1;
  const result = db.prepare('INSERT INTO todos (content, date, sort_order) VALUES (?, ?, ?)').run(content.trim(), targetDate, order);
  res.json({ success: true, data: getTodoWithSubtasks(result.lastInsertRowid) });
});

app.patch('/api/todos/:id/toggle', (req, res) => {
  const { id } = req.params;
  const todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(id);
  if (!todo) return res.status(404).json({ success: false, message: 'Todo 不存在' });
  const newCompleted = todo.completed ? 0 : 1;
  db.prepare('UPDATE todos SET completed = ?, completed_at = ? WHERE id = ?').run(newCompleted, newCompleted ? new Date().toISOString() : null, id);
  db.prepare('UPDATE subtasks SET completed = ? WHERE todo_id = ?').run(newCompleted, id);
  res.json({ success: true, data: getTodoWithSubtasks(id) });
});

app.patch('/api/todos/:id', (req, res) => {
  const { id } = req.params;
  const { content, kr_id } = req.body;
  if (content !== undefined) {
    if (!content.trim()) return res.status(400).json({ success: false, message: '内容不能为空' });
    db.prepare('UPDATE todos SET content = ? WHERE id = ?').run(content.trim(), id);
  }
  if (kr_id !== undefined) {
    db.prepare('UPDATE todos SET kr_id = ? WHERE id = ?').run(kr_id, id);
  }
  res.json({ success: true, data: getTodoWithSubtasks(id) });
});

// 关联/解除关联 todo 与 KR
app.patch('/api/todos/:id/link-kr', (req, res) => {
  const { id } = req.params;
  const { kr_id } = req.body; // null 表示解除关联
  db.prepare('UPDATE todos SET kr_id = ? WHERE id = ?').run(kr_id || null, id);
  res.json({ success: true, data: getTodoWithSubtasks(id) });
});

app.delete('/api/todos/:id', (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM subtasks WHERE todo_id = ?').run(id);
  db.prepare('DELETE FROM todos WHERE id = ?').run(id);
  res.json({ success: true });
});

app.post('/api/todos/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ success: false });
  const stmt = db.prepare('UPDATE todos SET sort_order = ? WHERE id = ?');
  ids.forEach((id, i) => stmt.run(i, id));
  res.json({ success: true });
});

app.post('/api/subtasks/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ success: false });
  const stmt = db.prepare('UPDATE subtasks SET sort_order = ? WHERE id = ?');
  ids.forEach((id, i) => stmt.run(i, id));
  res.json({ success: true });
});

// ========== API: Subtasks ==========

app.post('/api/todos/:todoId/subtasks', (req, res) => {
  const { todoId } = req.params;
  const { content, parent_id } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ success: false, message: '内容不能为空' });
  const todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(todoId);
  if (!todo) return res.status(404).json({ success: false, message: 'Todo 不存在' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM subtasks WHERE todo_id = ? AND (parent_id IS ? OR parent_id = ?)').get(todoId, parent_id || null, parent_id || 0);
  db.prepare('INSERT INTO subtasks (todo_id, content, sort_order, parent_id) VALUES (?, ?, ?, ?)').run(todoId, content.trim(), (maxOrder.m || 0) + 1, parent_id || null);
  if (todo.completed) db.prepare('UPDATE todos SET completed = 0, completed_at = NULL WHERE id = ?').run(todoId);
  res.json({ success: true, data: getTodoWithSubtasks(todoId) });
});

app.patch('/api/subtasks/:id/toggle', (req, res) => {
  const { id } = req.params;
  const sub = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ success: false, message: '子任务不存在' });
  db.prepare('UPDATE subtasks SET completed = ? WHERE id = ?').run(sub.completed ? 0 : 1, id);
  // If this is a child subtask, sync parent subtask completion
  syncParentSubtask(parseInt(id));
  syncTodoCompleted(sub.todo_id);
  res.json({ success: true, data: getTodoWithSubtasks(sub.todo_id) });
});

app.patch('/api/subtasks/:id', (req, res) => {
  const { id } = req.params;
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ success: false, message: '内容不能为空' });
  const sub = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ success: false, message: '子任务不存在' });
  db.prepare('UPDATE subtasks SET content = ? WHERE id = ?').run(content.trim(), id);
  res.json({ success: true, data: getTodoWithSubtasks(sub.todo_id) });
});

app.delete('/api/subtasks/:id', (req, res) => {
  const { id } = req.params;
  const sub = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ success: false, message: '子任务不存在' });
  const todoId = sub.todo_id;
  const parentId = sub.parent_id;
  // Also delete children of this subtask
  db.prepare('DELETE FROM subtasks WHERE parent_id = ?').run(id);
  db.prepare('DELETE FROM subtasks WHERE id = ?').run(id);
  // Sync parent if this was a child
  if (parentId) syncParentSubtask(parentId);
  syncTodoCompleted(todoId);
  res.json({ success: true, data: getTodoWithSubtasks(todoId) });
});

// ========== API: OKR ==========

// 获取所有 KR（含目标标题），用于关联下拉
app.get('/api/okr/all-krs', (req, res) => {
  const krs = db.prepare(`
    SELECT kr.id, kr.content, kr.progress, kr.objective_id, o.title as objective_title
    FROM key_results kr JOIN objectives o ON kr.objective_id = o.id
    ORDER BY o.sort_order ASC, o.id ASC, kr.sort_order ASC, kr.id ASC
  `).all();
  res.json({ success: true, data: krs });
});

function getObjectiveWithKRs(objId) {
  const obj = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objId);
  if (!obj) return null;
  obj.key_results = db.prepare('SELECT * FROM key_results WHERE objective_id = ? ORDER BY sort_order ASC, id ASC').all(objId);
  return obj;
}

function getAllOKRs() {
  const objs = db.prepare('SELECT * FROM objectives ORDER BY sort_order ASC, id ASC').all();
  const krStmt = db.prepare('SELECT * FROM key_results WHERE objective_id = ? ORDER BY sort_order ASC, id ASC');
  return objs.map(o => { o.key_results = krStmt.all(o.id); return o; });
}

app.get('/api/okr', (req, res) => {
  res.json({ success: true, data: getAllOKRs() });
});

app.post('/api/okr/objectives', (req, res) => {
  const { title } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ success: false, message: '目标不能为空' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM objectives').get();
  const result = db.prepare('INSERT INTO objectives (title, sort_order) VALUES (?, ?)').run(title.trim(), (maxOrder.m || 0) + 1);
  res.json({ success: true, data: getObjectiveWithKRs(result.lastInsertRowid) });
});

app.patch('/api/okr/objectives/:id', (req, res) => {
  const { id } = req.params;
  const { title } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ success: false, message: '目标不能为空' });
  db.prepare('UPDATE objectives SET title = ? WHERE id = ?').run(title.trim(), id);
  res.json({ success: true, data: getObjectiveWithKRs(id) });
});

app.delete('/api/okr/objectives/:id', (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM key_results WHERE objective_id = ?').run(id);
  db.prepare('DELETE FROM objectives WHERE id = ?').run(id);
  res.json({ success: true });
});

app.post('/api/okr/objectives/:objId/kr', (req, res) => {
  const { objId } = req.params;
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ success: false, message: 'KR 不能为空' });
  const obj = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objId);
  if (!obj) return res.status(404).json({ success: false, message: '目标不存在' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM key_results WHERE objective_id = ?').get(objId);
  db.prepare('INSERT INTO key_results (objective_id, content, sort_order) VALUES (?, ?, ?)').run(objId, content.trim(), (maxOrder.m || 0) + 1);
  res.json({ success: true, data: getObjectiveWithKRs(objId) });
});

app.patch('/api/okr/kr/:id', (req, res) => {
  const { id } = req.params;
  const { content, progress } = req.body;
  const kr = db.prepare('SELECT * FROM key_results WHERE id = ?').get(id);
  if (!kr) return res.status(404).json({ success: false, message: 'KR 不存在' });
  if (content !== undefined) db.prepare('UPDATE key_results SET content = ? WHERE id = ?').run(content.trim(), id);
  if (progress !== undefined) db.prepare('UPDATE key_results SET progress = ? WHERE id = ?').run(Math.max(0, Math.min(100, parseInt(progress))), id);
  res.json({ success: true, data: getObjectiveWithKRs(kr.objective_id) });
});

app.delete('/api/okr/kr/:id', (req, res) => {
  const { id } = req.params;
  const kr = db.prepare('SELECT * FROM key_results WHERE id = ?').get(id);
  if (!kr) return res.status(404).json({ success: false, message: 'KR 不存在' });
  db.prepare('DELETE FROM key_results WHERE id = ?').run(id);
  res.json({ success: true });
});

// KR 添加到今日待办
app.post('/api/okr/kr/:id/to-todo', (req, res) => {
  const { id } = req.params;
  const { date } = req.body;
  const kr = db.prepare('SELECT kr.*, o.title as obj_title FROM key_results kr JOIN objectives o ON kr.objective_id = o.id WHERE kr.id = ?').get(id);
  if (!kr) return res.status(404).json({ success: false, message: 'KR 不存在' });
  const targetDate = date || getTodayStr();
  const exists = db.prepare('SELECT id FROM todos WHERE kr_id = ? AND date = ?').get(kr.id, targetDate);
  if (exists) return res.json({ success: false, message: '待办中已存在该 KR' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM todos WHERE date = ?').get(targetDate);
  const result = db.prepare('INSERT INTO todos (content, date, sort_order, kr_id) VALUES (?, ?, ?, ?)').run(kr.content, targetDate, (maxOrder.m || 0) + 1, kr.id);
  res.json({ success: true, message: '已添加到待办', todoId: result.lastInsertRowid });
});

// ========== API: Weekly Reports ==========

// 获取某周已完成任务的甘特数据（实时查询，不依赖stored report）
app.get('/api/reports/weekly-gantt', (req, res) => {
  const date = req.query.date || getTodayStr();
  const { start, end } = getWeekRange(date);
  
  // Get all days in the week
  const days = [];
  const cur = new Date(start + 'T00:00:00');
  const endDate = new Date(end + 'T00:00:00');
  while (cur <= endDate) {
    days.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }
  
  // Collect completed tasks across the week
  const taskMap = new Map();
  
  days.forEach(dateStr => {
    const todos = getTodosWithSubtasks(dateStr);
    todos.forEach(t => {
      const isKR = !!t.kr_id;
      
      if (isKR) {
        // For KR todos: collect each completed top-level subtask (the "todo" items) as separate entries
        (t.subtasks || []).forEach(s => {
          if (s.completed) {
            const key = `kr:${t.content}:${s.content}`;
            if (!taskMap.has(key)) {
              taskMap.set(key, {
                content: s.content,
                krName: t.content,
                days: new Set(),
                subtasks: [],
                isKR: true
              });
            }
            taskMap.get(key).days.add(dateStr);
            // Merge children as subtasks
            const existing = taskMap.get(key);
            (s.children || []).forEach(c => {
              if (c.completed && !existing.subtasks.find(x => x.content === c.content)) {
                existing.subtasks.push({ content: c.content });
              }
            });
          }
        });
      } else if (t.completed) {
        // Normal completed todo
        const key = t.content;
        if (!taskMap.has(key)) {
          taskMap.set(key, {
            content: t.content,
            days: new Set(),
            subtasks: [],
            isKR: false
          });
        }
        taskMap.get(key).days.add(dateStr);
        const existing = taskMap.get(key);
        (t.subtasks || []).forEach(s => {
          if (s.completed && !existing.subtasks.find(x => x.content === s.content)) {
            existing.subtasks.push({ content: s.content });
          }
          (s.children || []).forEach(c => {
            if (c.completed && !existing.subtasks.find(x => x.content === c.content)) {
              existing.subtasks.push({ content: c.content });
            }
          });
        });
      }
    });
  });
  
  const tasks = Array.from(taskMap.values()).map(t => ({
    content: t.content,
    krName: t.krName || null,
    isKR: t.isKR,
    days: Array.from(t.days).sort(),
    startDate: Array.from(t.days).sort()[0],
    endDate: Array.from(t.days).sort().pop(),
    dayCount: t.days.size,
    subtasks: t.subtasks
  }));
  
  res.json({ 
    success: true, 
    data: { 
      weekStart: start, 
      weekEnd: end, 
      weekDays: days,
      weekNum: getWeekNumber(start),
      tasks,
      totalCompleted: tasks.length
    }
  });
});

// 获取某月的周报列表
app.get('/api/reports', (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
  const reports = db.prepare(`
    SELECT id, week_start, week_end, year, month, week_num,
           total_tasks, completed_tasks, total_subtasks, completed_subtasks, created_at
    FROM weekly_reports
    WHERE year = ? AND month = ?
    ORDER BY week_start DESC
  `).all(year, month);
  res.json({ success: true, data: reports, year, month });
});

// 获取某份周报详情
app.get('/api/reports/:id', (req, res) => {
  const { id } = req.params;
  const report = db.prepare('SELECT * FROM weekly_reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ success: false, message: '周报不存在' });
  report.report = JSON.parse(report.report_json);
  delete report.report_json;
  res.json({ success: true, data: report });
});

// 手动生成某周的周报
app.post('/api/reports/generate', (req, res) => {
  const { date } = req.body;
  const targetDate = date || getTodayStr();
  const { start, end } = getWeekRange(targetDate);
  const id = generateWeeklyReport(start, end);
  const report = db.prepare('SELECT * FROM weekly_reports WHERE id = ?').get(id);
  report.report = JSON.parse(report.report_json);
  delete report.report_json;
  res.json({ success: true, data: report });
});

// 获取有周报的年月列表
app.get('/api/reports/months', (req, res) => {
  const months = db.prepare(`
    SELECT DISTINCT year, month FROM weekly_reports ORDER BY year DESC, month DESC
  `).all();
  res.json({ success: true, data: months });
});

// ========== Config ==========

app.get('/api/config', (req, res) => {
  const rows = db.prepare('SELECT * FROM config').all();
  const config = {};
  rows.forEach(r => { config[r.key] = r.value; });
  res.json({ success: true, data: config });
});

app.post('/api/config', (req, res) => {
  const { webhook_url, tool_url } = req.body;
  if (webhook_url !== undefined) db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('webhook_url', webhook_url);
  if (tool_url !== undefined) db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('tool_url', tool_url);
  res.json({ success: true });
});

app.post('/api/notify/test', async (req, res) => {
  const { type } = req.body;
  try {
    if (type === 'morning') await morningNotify();
    else await eveningNotify();
    res.json({ success: true, message: '通知已发送' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/carry-over', (req, res) => {
  const count = carryOverTasks();
  res.json({ success: true, message: `已累积 ${count} 个未完成任务到今天` });
});

// ========== 通知逻辑 ==========
function getWebhookUrl() {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get('webhook_url');
  return row ? row.value : '';
}

async function morningNotify() {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) { console.log('[通知] Webhook URL 未配置'); return; }
  const carriedCount = carryOverTasks();
  const today = getTodayStr();
  const todos = getTodosWithSubtasks(today);
  const toolUrl = getToolUrl();
  const pending = todos.filter(t => !t.completed);

  let content = `## 📋 betterli 的早间提醒\n\n`;
  content += `今日共有 **${todos.length}** 项待办`;
  if (carriedCount > 0) content += `，其中 **${carriedCount}** 项为昨日遗留`;
  content += `\n\n`;
  if (pending.length > 0) {
    pending.forEach((t, i) => { content += `${i + 1}. ${t.content}${t.carried_from ? ' 🔴' : ''}\n`; });
    content += '\n';
  }
  content += `[👉 打开待办工具](${toolUrl})`;
  await sendWechatNotification(webhookUrl, { msgtype: 'markdown', markdown: { content } });
  console.log(`[通知] 早间提醒已发送 (${today})`);
}

async function eveningNotify() {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) { console.log('[通知] Webhook URL 未配置'); return; }
  const today = getTodayStr();
  const todos = getTodosWithSubtasks(today);
  const toolUrl = getToolUrl();
  const completed = todos.filter(t => t.completed);
  const uncompleted = todos.filter(t => !t.completed);

  let content = `## 📊 betterli 的日终总结\n\n`;
  content += `今日待办 **${todos.length}** 项，已完成 **${completed.length}** 项`;
  if (uncompleted.length > 0) content += `，未完成 **${uncompleted.length}** 项`;
  content += `\n\n`;
  if (uncompleted.length > 0) {
    content += `### 未完成任务\n`;
    uncompleted.forEach((t, i) => { content += `${i + 1}. ${t.content}\n`; });
    content += `\n> ⚠️ 以上任务将自动累积到明天\n\n`;
  } else { content += `🎉 **恭喜！今天的任务全部完成！**\n\n`; }
  content += `[👉 打开待办工具](${toolUrl})`;
  await sendWechatNotification(webhookUrl, { msgtype: 'markdown', markdown: { content } });
  console.log(`[通知] 日终总结已发送 (${today})`);
}

// ========== 未完成任务累积 ==========
function carryOverTasks() {
  const today = getTodayStr();
  const yesterday = getYesterdayStr();
  const uncompletedYesterday = db.prepare('SELECT * FROM todos WHERE date = ? AND completed = 0').all(yesterday);
  let carriedCount = 0;
  const insertTodo = db.prepare('INSERT INTO todos (content, date, carried_from) VALUES (?, ?, ?)');
  const insertSub = db.prepare('INSERT INTO subtasks (todo_id, content, completed, sort_order) VALUES (?, ?, ?, ?)');
  const markDone = db.prepare('UPDATE todos SET completed = 1, completed_at = ? WHERE id = ?');
  const getSubs = db.prepare('SELECT * FROM subtasks WHERE todo_id = ? ORDER BY sort_order ASC, id ASC');

  for (const todo of uncompletedYesterday) {
    const exists = db.prepare('SELECT id FROM todos WHERE date = ? AND content = ? AND carried_from = ?').get(today, todo.content, yesterday);
    if (!exists) {
      const result = insertTodo.run(todo.content, today, yesterday);
      getSubs.all(todo.id).forEach(s => { if (!s.completed) insertSub.run(result.lastInsertRowid, s.content, 0, s.sort_order); });
      markDone.run(new Date().toISOString(), todo.id);
      carriedCount++;
    }
  }
  if (carriedCount > 0) console.log(`[累积] ${yesterday} → ${today}: ${carriedCount} 个任务`);
  return carriedCount;
}

// ========== 定时任务 ==========
cron.schedule('30 9 * * *', () => {
  console.log('[定时] 触发早间提醒...');
  morningNotify().catch(err => console.error('[定时] 早间提醒失败:', err));
});

cron.schedule('30 17 * * *', () => {
  console.log('[定时] 触发日终总结...');
  eveningNotify().catch(err => console.error('[定时] 日终总结失败:', err));
});

// 每周五 18:00 自动生成周报
cron.schedule('0 18 * * 5', () => {
  console.log('[定时] 触发周报生成...');
  try {
    const today = getTodayStr();
    const { start, end } = getWeekRange(today);
    generateWeeklyReport(start, end);
  } catch (err) { console.error('[定时] 周报生成失败:', err); }
});

console.log('[定时] 已注册: 09:30 早间提醒, 17:30 日终总结, 周五 18:00 生成周报');

app.listen(PORT, () => {
  console.log(`\n🚀 betterli 的待办服务已启动`);
  console.log(`📍 访问地址: http://localhost:${PORT}`);
  console.log(`⏰ 09:30 早间提醒 / 17:30 日终总结 / 周五 18:00 周报\n`);
});
