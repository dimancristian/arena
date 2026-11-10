'use strict';
const mysql = require('mysql2/promise');

function normalizeDate(value) {
  return value instanceof Date ? value.toISOString() : value;
}
function validInt(value, fallback = null) {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}
async function createGameStore(config = {}) {
  const pool = mysql.createPool({
    host: config.host || process.env.DB_HOST || 'localhost',
    port: Number(config.port || process.env.DB_PORT || 3306),
    user: config.user || process.env.DB_USER,
    password: config.password ?? process.env.DB_PASSWORD,
    database: config.database || process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(config.connectionLimit || process.env.DB_POOL_LIMIT || 5),
    timezone: 'Z',
    supportBigNumbers: true,
    ...config.poolOptions
  });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS games (
      id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      room_code VARCHAR(80), room_name VARCHAR(120), grade TINYINT UNSIGNED,
      mode VARCHAR(40), started_at DATETIME(3) NOT NULL, finished_at DATETIME(3),
      status ENUM('active','finished','abandoned') NOT NULL DEFAULT 'active',
      total_questions INT UNSIGNED NOT NULL DEFAULT 0,
      INDEX ix_games_finished (status, finished_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.query(`CREATE TABLE IF NOT EXISTS game_players (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      game_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      player_key VARCHAR(128) NOT NULL, display_name VARCHAR(80) NOT NULL,
      score INT NOT NULL DEFAULT 0, correct_answers INT UNSIGNED NOT NULL DEFAULT 0,
      wrong_answers INT UNSIGNED NOT NULL DEFAULT 0, final_position INT UNSIGNED,
      UNIQUE KEY uq_player (game_id, player_key),
      CONSTRAINT fk_gp_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.query(`CREATE TABLE IF NOT EXISTS game_answers (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      game_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      player_id BIGINT UNSIGNED NOT NULL,
      question_key VARCHAR(128) NOT NULL, category VARCHAR(60),
      correct TINYINT(1) NOT NULL,
      response_time_ms INT UNSIGNED,
      created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_answer (game_id, player_id, question_key),
      INDEX ix_answers_game (game_id),
      CONSTRAINT fk_ga_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
      CONSTRAINT fk_ga_player FOREIGN KEY (player_id) REFERENCES game_players(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  } catch (error) {
    await pool.end();
    throw error;
  }

  async function transaction(callback) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function start(game) {
    if (!game || !game.id) throw new Error('Este necesar un identificator unic de partidă.');
    return transaction(async db => {
      const id = String(game.id);
      const [insert] = await db.execute(`INSERT IGNORE INTO games
        (id, room_code, room_name, grade, mode, started_at, total_questions)
        VALUES(?,?,?,?,?,UTC_TIMESTAMP(3),?)`, [id,
        String(game.roomCode || '').slice(0,80), String(game.roomName || '').slice(0,120),
        [1,2,3,4].includes(validInt(game.grade)) ? Number(game.grade) : null,
        String(game.mode || '').slice(0,40), Math.max(0,validInt(game.totalQuestions,0))]);
      // Un ID deja existent nu trebuie să suprascrie rezultatele unui joc încheiat.
      if (!insert.affectedRows) return false;
      for (const player of game.players || []) {
        if (player.id === undefined || player.id === null) continue;
        await db.execute(`INSERT INTO game_players(game_id,player_key,display_name)
          VALUES(?,?,?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)`,
          [id,String(player.id).slice(0,128),String(player.name || 'Jucător').slice(0,80)]);
      }
      return true;
    });
  }

  async function answer(event) {
    if (!event || event.gameId == null || event.playerId == null || event.questionKey == null) return false;
    return transaction(async db => {
      const id = String(event.gameId), key = String(event.playerId);
      const [games] = await db.execute('SELECT id FROM games WHERE id=? AND status=? FOR UPDATE',[id,'active']);
      if (!games.length) return false;
      const [players] = await db.execute('SELECT id FROM game_players WHERE game_id=? AND player_key=?',[id,key]);
      if (!players.length) return false;
      const responseTime = Number(event.responseTimeMs);
      const [result] = await db.execute(`INSERT IGNORE INTO game_answers
        (game_id,player_id,question_key,category,correct,response_time_ms,created_at)
        VALUES(?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [id,players[0].id,String(event.questionKey).slice(0,128),
          String(event.category || '').slice(0,60), event.correct ? 1 : 0,
          Number.isFinite(responseTime) && responseTime >= 0 ? Math.round(responseTime) : null]);
      return result.affectedRows > 0;
    });
  }

  async function complete(gameId, results = []) {
    return transaction(async db => {
      const id = String(gameId);
      const [result] = await db.execute(`UPDATE games SET status='finished',finished_at=UTC_TIMESTAMP(3)
        WHERE id=? AND status='active'`,[id]);
      if (!result.affectedRows) return false;
      for (const player of results || []) {
        if (player.id == null) continue;
        const [rows] = await db.execute(`SELECT id FROM game_players
          WHERE game_id=? AND player_key=?`,[id,String(player.id)]);
        if (!rows.length) continue;
        const [counts] = await db.execute(`SELECT COALESCE(SUM(correct),0) AS good, COUNT(*) AS total
          FROM game_answers WHERE player_id=?`,[rows[0].id]);
        const good = Number(counts[0].good), wrong = Number(counts[0].total)-good;
        await db.execute(`UPDATE game_players SET score=?,correct_answers=?,wrong_answers=?,final_position=?
          WHERE id=?`,[validInt(player.score,0),good,wrong,
            validInt(player.position) > 0 ? validInt(player.position) : null,rows[0].id]);
      }
      return true;
    });
  }
  async function abandon(gameId) {
    const [result] = await pool.execute(`UPDATE games SET status='abandoned',finished_at=UTC_TIMESTAMP(3)
      WHERE id=? AND status='active'`,[String(gameId)]);
    return result.affectedRows > 0;
  }
  async function overview() {
    const [[totals], [accuracy], [trend], [grades]] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT g.id) AS games, COUNT(DISTINCT gp.player_key) AS players,
        COALESCE((SELECT ROUND(AVG(TIMESTAMPDIFF(SECOND,x.started_at,x.finished_at)))
          FROM games x WHERE x.status='finished'),0) AS avg_seconds
        FROM games g LEFT JOIN game_players gp ON gp.game_id=g.id WHERE g.status='finished'`),
      pool.query(`SELECT COUNT(*) AS answers, COALESCE(SUM(a.correct),0) AS correct
        FROM game_answers a JOIN games g ON g.id=a.game_id WHERE g.status='finished'`),
      pool.query(`SELECT DATE_FORMAT(finished_at,'%Y-%m-%d') AS day, COUNT(*) AS games
        FROM games WHERE status='finished' AND finished_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY
        GROUP BY DATE(finished_at) ORDER BY day`),
      pool.query(`SELECT grade, COUNT(*) AS games FROM games WHERE status='finished'
        GROUP BY grade ORDER BY grade`)
    ]);
    const t=totals[0], a=accuracy[0];
    return {games:Number(t.games),players:Number(t.players),avg_seconds:Number(t.avg_seconds),
      accuracy:Number(a.answers)?Math.round(Number(a.correct)*1000/Number(a.answers))/10:0,
      trend:trend.map(x=>({day:x.day,games:Number(x.games)})),
      grades:grades.map(x=>({grade:x.grade,games:Number(x.games)}))};
  }
  async function listGames({page=1,grade=null}={}) {
    const current=Math.min(10000,Math.max(1,parseInt(page,10)||1));
    const level=[1,2,3,4].includes(Number(grade))?Number(grade):null;
    const [rows]=await pool.execute(`SELECT g.id,g.room_name,g.room_code,g.grade,g.mode,g.started_at,g.finished_at,
      (SELECT COUNT(*) FROM game_players p WHERE p.game_id=g.id) AS players,
      (SELECT p2.display_name FROM game_players p2 WHERE p2.game_id=g.id
        ORDER BY p2.final_position IS NULL,p2.final_position,p2.score DESC LIMIT 1) AS winner
      FROM games g WHERE g.status='finished' AND (? IS NULL OR g.grade=?)
      ORDER BY g.finished_at DESC LIMIT 25 OFFSET ?`,[level,level,(current-1)*25]);
    return rows.map(x=>({...x,players:Number(x.players),started_at:normalizeDate(x.started_at),
      finished_at:normalizeDate(x.finished_at)}));
  }
  async function gameDetails(gameId) {
    const [rows]=await pool.execute('SELECT * FROM games WHERE id=?',[String(gameId)]);
    if (!rows.length) return null;
    const game={...rows[0],started_at:normalizeDate(rows[0].started_at),finished_at:normalizeDate(rows[0].finished_at)};
    const [[players],[categories]]=await Promise.all([
      pool.execute(`SELECT id,display_name,score,correct_answers,wrong_answers,final_position
        FROM game_players WHERE game_id=? ORDER BY final_position IS NULL,final_position,score DESC`,[game.id]),
      pool.execute(`SELECT category,COUNT(*) AS answers,COALESCE(SUM(correct),0) AS correct
        FROM game_answers WHERE game_id=? GROUP BY category ORDER BY answers DESC`,[game.id])
    ]);
    return {game,players,categories:categories.map(x=>({...x,answers:Number(x.answers),correct:Number(x.correct)}))};
  }
  return {start,answer,complete,abandon,overview,listGames,gameDetails,close:()=>pool.end()};
}
module.exports = {createGameStore};
