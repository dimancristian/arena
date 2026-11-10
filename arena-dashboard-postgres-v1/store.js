'use strict';
const { Pool } = require('pg');

const ddl = `
CREATE TABLE IF NOT EXISTS games (
 id VARCHAR(128) PRIMARY KEY, room_code VARCHAR(80), room_name VARCHAR(120),
 grade SMALLINT, mode VARCHAR(40), started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 finished_at TIMESTAMPTZ,
 status VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','abandoned')),
 total_questions INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_games_finished ON games(status,finished_at);
CREATE TABLE IF NOT EXISTS game_players (
 id BIGSERIAL PRIMARY KEY, game_id VARCHAR(128) NOT NULL REFERENCES games(id) ON DELETE CASCADE,
 player_key VARCHAR(128) NOT NULL, display_name VARCHAR(80) NOT NULL,
 score INTEGER NOT NULL DEFAULT 0, correct_answers INTEGER NOT NULL DEFAULT 0,
 wrong_answers INTEGER NOT NULL DEFAULT 0, final_position INTEGER,
 UNIQUE(game_id,player_key)
);
CREATE TABLE IF NOT EXISTS game_answers (
 id BIGSERIAL PRIMARY KEY, game_id VARCHAR(128) NOT NULL REFERENCES games(id) ON DELETE CASCADE,
 player_id BIGINT NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
 question_key VARCHAR(128) NOT NULL, category VARCHAR(60),correct BOOLEAN NOT NULL,
 response_time_ms INTEGER,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(game_id,player_id,question_key)
);
CREATE INDEX IF NOT EXISTS ix_answers_game ON game_answers(game_id);
`;
function validInt(value, fallback=null) { const n=Number(value); return Number.isSafeInteger(n)?n:fallback; }
function num(v) { return Number(v || 0); }
async function createGameStore(config={}) {
 const connectionString=config.connectionString || process.env.DATABASE_URL;
 if(!connectionString && !config.host && !process.env.PGHOST) throw new Error('Configurează DATABASE_URL cu Internal Database URL din Render PostgreSQL.');
 const pool = new Pool({
  ...(connectionString ? {connectionString} : {
    host:config.host || process.env.PGHOST,
    port:Number(config.port || process.env.PGPORT || 5432),
    user:config.user || process.env.PGUSER,
    password:config.password ?? process.env.PGPASSWORD,
    database:config.database || process.env.PGDATABASE
  }),
  max:Number(config.max || process.env.PG_POOL_LIMIT || 5),
  connectionTimeoutMillis:15000,
  idleTimeoutMillis:30000,
  ...config.poolOptions
 });
 pool.on('error',err=>console.error('[Dashboard PostgreSQL] Eroare conexiune inactivă:',err.message));
 try { await pool.query(ddl); }
 catch(err) { await pool.end(); throw err; }
 async function transaction(fn) {
  const client=await pool.connect();
  try {await client.query('BEGIN');const r=await fn(client);await client.query('COMMIT');return r;}
  catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
  finally{client.release();}
 }
 async function start(game) {
  if(!game?.id) throw new Error('Este necesar un identificator unic de partidă.');
  return transaction(async db=>{
   const id=String(game.id);
   const inserted=await db.query(`INSERT INTO games(id,room_code,room_name,grade,mode,total_questions)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING id`,[
      id,String(game.roomCode||'').slice(0,80),String(game.roomName||'').slice(0,120),
      [1,2,3,4].includes(validInt(game.grade))?Number(game.grade):null,
      String(game.mode||'').slice(0,40),Math.max(0,validInt(game.totalQuestions,0))]);
   if(!inserted.rowCount)return false;
   for(const p of game.players || []){
    if(p.id==null)continue;
    await db.query(`INSERT INTO game_players(game_id,player_key,display_name) VALUES($1,$2,$3)
      ON CONFLICT(game_id,player_key) DO UPDATE SET display_name=EXCLUDED.display_name`,
      [id,String(p.id).slice(0,128),String(p.name||'Jucător').slice(0,80)]);
   }
   return true;
  });
 }
 async function answer(event){
  if(event?.gameId==null || event.playerId==null || event.questionKey==null)return false;
  return transaction(async db=>{
   const id=String(event.gameId), key=String(event.playerId);
   const game=await db.query('SELECT id FROM games WHERE id=$1 AND status=$2 FOR UPDATE',[id,'active']);
   if(!game.rowCount)return false;
   const players=await db.query('SELECT id FROM game_players WHERE game_id=$1 AND player_key=$2',[id,key]);
   if(!players.rowCount)return false;
   const t=Number(event.responseTimeMs);
   const r=await db.query(`INSERT INTO game_answers(game_id,player_id,question_key,category,correct,response_time_ms)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(game_id,player_id,question_key) DO NOTHING`,[
      id,players.rows[0].id,String(event.questionKey).slice(0,128),String(event.category||'').slice(0,60),
      Boolean(event.correct),Number.isFinite(t)&&t>=0?Math.min(2147483647,Math.round(t)):null]);
   return r.rowCount>0;
  });
 }
 async function complete(gameId,results=[]){
  return transaction(async db=>{
   const id=String(gameId);
   const changed=await db.query(`UPDATE games SET status='finished',finished_at=now()
     WHERE id=$1 AND status='active' RETURNING id`,[id]);
   if(!changed.rowCount)return false;
   for(const p of results){
    if(p.id==null)continue;
    const player=await db.query('SELECT id FROM game_players WHERE game_id=$1 AND player_key=$2',[id,String(p.id)]);
    if(!player.rowCount)continue;
    const r=await db.query(`SELECT COUNT(*) FILTER (WHERE correct) AS good,
      COUNT(*) FILTER (WHERE NOT correct) AS bad FROM game_answers WHERE player_id=$1`,[player.rows[0].id]);
    await db.query(`UPDATE game_players SET score=$1,correct_answers=$2,wrong_answers=$3,final_position=$4 WHERE id=$5`,[
      validInt(p.score,0),num(r.rows[0].good),num(r.rows[0].bad),
      validInt(p.position)>0?validInt(p.position):null,player.rows[0].id]);
   }
   return true;
  });
 }
 async function abandon(gameId){
  const r=await pool.query(`UPDATE games SET status='abandoned',finished_at=now()
    WHERE id=$1 AND status='active'`,[String(gameId)]);
  return r.rowCount>0;
 }
 async function overview(){
  const [totals,accuracy,trend,grades]=await Promise.all([
   pool.query(`SELECT COUNT(DISTINCT g.id) AS games, COUNT(DISTINCT gp.player_key) AS players,
     COALESCE((SELECT ROUND(AVG(EXTRACT(EPOCH FROM (x.finished_at-x.started_at))))
       FROM games x WHERE x.status='finished'),0) AS avg_seconds
     FROM games g LEFT JOIN game_players gp ON gp.game_id=g.id WHERE g.status='finished'`),
   pool.query(`SELECT COUNT(*) AS answers, COUNT(*) FILTER(WHERE a.correct) AS correct
     FROM game_answers a JOIN games g ON g.id=a.game_id WHERE g.status='finished'`),
   pool.query(`SELECT to_char(finished_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,COUNT(*) AS games
     FROM games WHERE status='finished' AND finished_at>=now()-INTERVAL '30 days'
     GROUP BY 1 ORDER BY 1`),
   pool.query(`SELECT grade,COUNT(*) AS games FROM games WHERE status='finished' GROUP BY grade ORDER BY grade`)
  ]);
  const t=totals.rows[0],a=accuracy.rows[0];
  return {games:num(t.games),players:num(t.players),avg_seconds:num(t.avg_seconds),
    accuracy:num(a.answers)?Math.round(num(a.correct)*1000/num(a.answers))/10:0,
    trend:trend.rows.map(x=>({day:x.day,games:num(x.games)})),
    grades:grades.rows.map(x=>({grade:x.grade,games:num(x.games)}))};
 }
 async function listGames({page=1,grade=null}={}){
  const current=Math.min(10000,Math.max(1,parseInt(page,10)||1));
  const level=[1,2,3,4].includes(Number(grade))?Number(grade):null;
  const r=await pool.query(`SELECT g.id,g.room_name,g.room_code,g.grade,g.mode,g.started_at,g.finished_at,
    (SELECT COUNT(*) FROM game_players p WHERE p.game_id=g.id) AS players,
    (SELECT p2.display_name FROM game_players p2 WHERE p2.game_id=g.id
      ORDER BY p2.final_position IS NULL,p2.final_position,p2.score DESC LIMIT 1) AS winner
    FROM games g WHERE g.status='finished' AND ($1::smallint IS NULL OR g.grade=$1::smallint)
    ORDER BY g.finished_at DESC LIMIT 25 OFFSET $2`,[level,(current-1)*25]);
  return r.rows.map(x=>({...x,players:num(x.players)}));
 }
 async function gameDetails(gameId){
  const r=await pool.query('SELECT * FROM games WHERE id=$1',[String(gameId)]);
  if(!r.rowCount)return null;
  const game=r.rows[0];
  const [players,categories]=await Promise.all([
   pool.query(`SELECT id,display_name,score,correct_answers,wrong_answers,final_position
     FROM game_players WHERE game_id=$1 ORDER BY final_position IS NULL,final_position,score DESC`,[game.id]),
   pool.query(`SELECT category,COUNT(*) AS answers,COUNT(*) FILTER(WHERE correct) AS correct
     FROM game_answers WHERE game_id=$1 GROUP BY category ORDER BY answers DESC`,[game.id])
  ]);
  return {game,players:players.rows,categories:categories.rows.map(x=>({...x,answers:num(x.answers),correct:num(x.correct)}))};
 }
 return {start,answer,complete,abandon,overview,listGames,gameDetails,close:()=>pool.end()};
}
module.exports={createGameStore};
