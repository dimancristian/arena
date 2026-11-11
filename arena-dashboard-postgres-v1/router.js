'use strict';
const path = require('node:path');
const express = require('express');

// Montează routerul numai după middleware-ul de autentificare admin al aplicației.
function createDashboardRouter(store) {
  const router = express.Router();
  const handle = fn => (req,res,next) => Promise.resolve().then(()=>fn(req,res)).catch(next);
  router.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public','dashboard.html')));
  router.get('/api/overview',handle(async(req,res)=>res.json(await store.overview())));
  router.get('/admin/api/games',handle(async(req,res)=>res.json(await store.listGames({page:req.query.page,grade:req.query.grade}))));
  router.get('/admin/api/games/:id',handle(async(req,res)=>{
    const data=await store.gameDetails(req.params.id);
    if(!data)return res.status(404).json({error:'Partida nu există.'});
    res.json(data);
  }));
  return router;
}
module.exports = {createDashboardRouter};
