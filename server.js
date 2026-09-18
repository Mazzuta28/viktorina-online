const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const QUIZZES_FILE = path.join(DATA_DIR, 'quizzes.json');
const AVATARS = ['🦊','🐼','🐯','🐸','🐵','🐰','🐨','🦁','🐧','🐙','🦄','🤖'];

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(QUIZZES_FILE)) fs.writeFileSync(QUIZZES_FILE, '[]', 'utf8');

const rooms = new Map();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml'
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function text(res, status, body, type='text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
async function readBody(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('too-large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('bad-json'); }
}
function readQuizzes(){ try{return JSON.parse(fs.readFileSync(QUIZZES_FILE,'utf8'));}catch{return [];} }
function writeQuizzes(q){ fs.writeFileSync(QUIZZES_FILE,JSON.stringify(q,null,2),'utf8'); }
function id(prefix=''){ return prefix + crypto.randomBytes(8).toString('hex'); }
function code(){ let c; do{c=String(Math.floor(100000+Math.random()*900000));}while(rooms.has(c)); return c; }
function shuffle(a){ a=[...a]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function numberValue(value){
  if(typeof value==='number' && Number.isFinite(value)) return value;
  if(typeof value!=='string') return null;
  const s=value.trim().replace(',','.');
  if(!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)) return null;
  const n=Number(s); return Number.isFinite(n)?n:null;
}
function cleanQuiz(body){
  const title=String(body.title||'').trim(); const qs=Array.isArray(body.questions)?body.questions:[];
  if(!title || !qs.length) throw new Error('Нужно название и хотя бы один вопрос');
  const questions=qs.map(src=>{
    const qtext=String(src.text||'').trim(); if(!qtext) throw new Error('Заполните текст каждого вопроса');
    if(src.type==='choice'){
      const options=Array.isArray(src.options)?src.options.map(x=>String(x).trim()).filter(Boolean):[];
      if(options.length<2) throw new Error('В вопросе с выбором должно быть минимум 2 варианта');
      const ci=Number(src.correctIndex); if(!Number.isInteger(ci)||ci<0||ci>=options.length) throw new Error('Укажите правильный вариант ответа');
      return {id:src.id||id('q_'),type:'choice',text:qtext,options,correctIndex:ci};
    }
    if(src.type==='number'){
      const n=numberValue(String(src.correctAnswer??'')); if(n===null) throw new Error('Числовой ответ должен быть целым числом или конечной десятичной дробью');
      return {id:src.id||id('q_'),type:'number',text:qtext,correctAnswer:n};
    }
    throw new Error('Неизвестный тип вопроса');
  });
  return {id:body.id||id('quiz_'),title,questions,updatedAt:new Date().toISOString()};
}
function makeStudentQuestions(room,p){
  return p.order.map((qi,pos)=>{
    const q=room.quiz.questions[qi];
    if(q.type==='choice') return {id:q.id,number:pos+1,type:'choice',text:q.text,options:p.optionOrders[qi].map(oi=>({key:oi,text:q.options[oi]}))};
    return {id:q.id,number:pos+1,type:'number',text:q.text};
  });
}
function leaderboard(room){
  const total=room.quiz.questions.length;
  const items=[...room.participants.values()].map(p=>({
    id:p.id,
    name:p.name,
    avatar:p.avatar,
    answered:p.answers.length,
    total,
    correct:p.answers.filter(a=>a.correct).length,
    score:p.score||0,
    finished:p.finished,
    joinedAt:p.joinedAt,
    totalResponseMs:p.totalResponseMs||0
  }));
  if(room.status==='active'){
    items.sort((a,b)=>
      b.score-a.score ||
      b.correct-a.correct ||
      a.totalResponseMs-b.totalResponseMs ||
      a.joinedAt-b.joinedAt
    );
  } else {
    items.sort((a,b)=>a.joinedAt-b.joinedAt);
  }
  return items.map((p,index)=>({...p,rank:index+1}));
}
function roomState(room){
  return {
    code:room.code,
    quizTitle:room.quiz.title,
    status:room.status,
    totalQuestions:room.quiz.questions.length,
    participantCount:room.participants.size,
    participants:leaderboard(room)
  };
}
function rankFor(room,participantId){
  const board=leaderboard(room); const item=board.find(x=>x.id===participantId);
  return {rank:item?.rank||board.length||1,totalPlayers:board.length};
}
function pointsForAnswer(correct,responseMs){
  if(!correct) return 0;
  const speedBonus=Math.max(0,Math.round(500*(1-Math.min(responseMs,30000)/30000)));
  return 1000+speedBonus;
}
function broadcast(room){
  const payload=`data: ${JSON.stringify(roomState(room))}\n\n`;
  for(const res of room.listeners){ try{res.write(payload);}catch{} }
}
function closeSse(room){ for(const res of room.listeners){try{res.end();}catch{}} room.listeners.clear(); }
function serveFile(res,file){
  if(!file.startsWith(PUBLIC_DIR)) return text(res,403,'Forbidden');
  fs.readFile(file,(err,data)=>{
    if(err)return text(res,404,'Не найдено');
    res.writeHead(200,{'content-type':MIME[path.extname(file)]||'application/octet-stream'});
    res.end(data);
  });
}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`); const pathname=decodeURIComponent(u.pathname);
  try{
    if(req.method==='GET' && pathname==='/api/quizzes') return json(res,200,readQuizzes().map(q=>({id:q.id,title:q.title,questionCount:q.questions.length,updatedAt:q.updatedAt})));
    let m=pathname.match(/^\/api\/quizzes\/([^/]+)$/);
    if(m && req.method==='GET'){const q=readQuizzes().find(x=>x.id===m[1]);return q?json(res,200,q):json(res,404,{error:'Викторина не найдена'});}
    if(pathname==='/api/quizzes' && req.method==='POST'){
      const body=await readBody(req); let q; try{q=cleanQuiz(body);}catch(e){return json(res,400,{error:e.message});}
      const all=readQuizzes(); const i=all.findIndex(x=>x.id===q.id); if(i>=0)all[i]=q;else all.push(q);writeQuizzes(all);return json(res,200,q);
    }
    if(m && req.method==='DELETE'){writeQuizzes(readQuizzes().filter(x=>x.id!==m[1]));return json(res,200,{ok:true});}

    // Создание комнаты теперь создаёт ЛОББИ. Викторина начинается только после кнопки «Старт» у учителя.
    if(pathname==='/api/rooms' && req.method==='POST'){
      const body=await readBody(req);
      let quiz;
      try {
        if (body.quiz) quiz=cleanQuiz(body.quiz);
        else if (body.quizId) quiz=readQuizzes().find(q=>q.id===body.quizId);
        if(!quiz) return json(res,404,{error:'Викторина не найдена'});
      } catch(e) { return json(res,400,{error:e.message}); }
      const c=code(),teacherToken=id('t_');
      rooms.set(c,{code:c,teacherToken,quiz,status:'lobby',createdAt:Date.now(),startedAt:null,participants:new Map(),listeners:new Set()});
      return json(res,200,{code:c,teacherToken,quizTitle:quiz.title,status:'lobby'});
    }

    m=pathname.match(/^\/api\/rooms\/(\d{6})$/);
    if(m && req.method==='GET'){
      const room=rooms.get(m[1]);
      if(!room||room.status==='closed')return json(res,404,{error:'Комната не найдена или уже закрыта'});
      return json(res,200,{code:room.code,quizTitle:room.quiz.title,status:room.status,questionCount:room.quiz.questions.length});
    }

    m=pathname.match(/^\/api\/rooms\/(\d{6})\/events$/);
    if(m && req.method==='GET'){
      const room=rooms.get(m[1]);if(!room||u.searchParams.get('token')!==room.teacherToken)return text(res,403,'Нет доступа');
      res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache','connection':'keep-alive','access-control-allow-origin':'*'});
      res.write(`data: ${JSON.stringify(roomState(room))}\n\n`);
      room.listeners.add(res);req.on('close',()=>room.listeners.delete(res));return;
    }

    // Подключаться можно и в лобби, и после старта — до тех пор, пока учитель не завершит игру.
    m=pathname.match(/^\/api\/rooms\/(\d{6})\/join$/);
    if(m && req.method==='POST'){
      const room=rooms.get(m[1]);
      if(!room||room.status==='closed')return json(res,404,{error:'Комната не найдена или уже закрыта'});
      const body=await readBody(req);
      const name=String(body.name||'').trim().slice(0,40);if(!name)return json(res,400,{error:'Введите имя'});
      const avatar=AVATARS.includes(body.avatar)?body.avatar:AVATARS[0];
      const now=Date.now();
      const p={
        id:id('p_'),name,avatar,joinedAt:now,
        order:shuffle(room.quiz.questions.map((_,i)=>i)),optionOrders:{},answers:[],current:0,
        finished:false,score:0,totalResponseMs:0,
        questionStartedAt:room.status==='active'?now:null
      };
      room.quiz.questions.forEach((q,i)=>{if(q.type==='choice')p.optionOrders[i]=shuffle(q.options.map((_,j)=>j));});
      room.participants.set(p.id,p);
      broadcast(room);
      const place=rankFor(room,p.id);
      return json(res,200,{
        participantId:p.id,quizTitle:room.quiz.title,questions:makeStudentQuestions(room,p),
        roomStatus:room.status,rank:place.rank,totalPlayers:room.participants.size,avatar:p.avatar
      });
    }

    // Только учитель запускает викторину.
    m=pathname.match(/^\/api\/rooms\/(\d{6})\/start$/);
    if(m && req.method==='POST'){
      const room=rooms.get(m[1]);if(!room)return json(res,404,{error:'Комната не найдена'});
      const body=await readBody(req);if(body.teacherToken!==room.teacherToken)return json(res,403,{error:'Нет доступа'});
      if(room.status==='closed')return json(res,410,{error:'Викторина уже завершена'});
      if(room.status==='active')return json(res,200,{ok:true,status:'active'});
      room.status='active';room.startedAt=Date.now();
      for(const p of room.participants.values()) if(!p.finished) p.questionStartedAt=room.startedAt;
      broadcast(room);
      return json(res,200,{ok:true,status:'active'});
    }

    m=pathname.match(/^\/api\/rooms\/(\d{6})\/answer$/);
    if(m && req.method==='POST'){
      const room=rooms.get(m[1]);
      if(!room||room.status==='closed')return json(res,410,{error:'Викторина завершена'});
      if(room.status!=='active')return json(res,409,{error:'Учитель ещё не запустил викторину'});
      const body=await readBody(req);const p=room.participants.get(String(body.participantId||''));
      if(!p||p.finished)return json(res,400,{error:'Участник не найден или уже закончил'});
      const qi=p.order[p.current],q=room.quiz.questions[qi];
      if(!q||q.id!==body.questionId)return json(res,409,{error:'Неверная последовательность вопроса'});
      let correct=false,answer=body.answer;
      if(q.type==='choice'){
        answer=Number(answer);correct=Number.isInteger(answer)&&answer===q.correctIndex;
      }else{
        answer=numberValue(String(answer??''));
        if(answer===null)return json(res,400,{error:'Введите целое число или конечную десятичную дробь',invalid:true});
        correct=Math.abs(answer-q.correctAnswer)<1e-12;
      }
      const answeredAt=Date.now();
      const responseMs=Math.max(0,answeredAt-(p.questionStartedAt||answeredAt));
      const pointsEarned=pointsForAnswer(correct,responseMs);
      p.score=(p.score||0)+pointsEarned;
      p.totalResponseMs=(p.totalResponseMs||0)+responseMs;
      p.answers.push({questionId:q.id,answer,correct,points:pointsEarned,responseMs,at:answeredAt});
      p.current++;
      if(p.current>=p.order.length)p.finished=true; else p.questionStartedAt=answeredAt+900;
      const place=rankFor(room,p.id);
      broadcast(room);
      return json(res,200,{correct,finished:p.finished,answered:p.answers.length,total:p.order.length,correctCount:p.answers.filter(a=>a.correct).length,pointsEarned,score:p.score,rank:place.rank,totalPlayers:place.totalPlayers});
    }

    m=pathname.match(/^\/api\/rooms\/(\d{6})\/status$/);
    if(m && req.method==='GET'){
      const room=rooms.get(m[1]); if(!room||room.status==='closed')return json(res,410,{status:'closed'});
      const participantId=u.searchParams.get('participantId');
      if(participantId){
        const p=room.participants.get(participantId); if(!p)return json(res,404,{error:'Участник не найден'});
        const place=rankFor(room,p.id);
        return json(res,200,{
          status:room.status,rank:place.rank,totalPlayers:place.totalPlayers,score:p.score||0,
          correct:p.answers.filter(a=>a.correct).length,answered:p.answers.length,total:room.quiz.questions.length,
          finished:p.finished,avatar:p.avatar,name:p.name
        });
      }
      return json(res,200,{status:room.status,participantCount:room.participants.size});
    }

    m=pathname.match(/^\/api\/rooms\/(\d{6})\/close$/);
    if(m && req.method==='POST'){
      const room=rooms.get(m[1]);if(!room)return json(res,404,{error:'Комната не найдена'});
      const body=await readBody(req);if(body.teacherToken!==room.teacherToken)return json(res,403,{error:'Нет доступа'});
      room.status='closed';broadcast(room);setTimeout(()=>{closeSse(room);rooms.delete(room.code);},3000);return json(res,200,{ok:true});
    }

    if(req.method==='GET'){
      if(pathname==='/') return serveFile(res,path.join(PUBLIC_DIR,'index.html'));
      if(pathname==='/teacher') return serveFile(res,path.join(PUBLIC_DIR,'teacher.html'));
      if(pathname==='/student') return serveFile(res,path.join(PUBLIC_DIR,'student.html'));
      const safe=path.normalize(pathname).replace(/^([.][.][/\\])+/, ''); return serveFile(res,path.join(PUBLIC_DIR,safe));
    }
    return json(res,404,{error:'Не найдено'});
  }catch(e){
    if(e.message==='too-large')return json(res,413,{error:'Слишком большой запрос'});
    if(e.message==='bad-json')return json(res,400,{error:'Некорректные данные'});
    console.error(e);return json(res,500,{error:'Ошибка сервера'});
  }
});

server.listen(PORT,'0.0.0.0',()=>{
  console.log(`\nВикторина запущена:`);
  console.log(`Учитель: http://localhost:${PORT}/teacher`);
  console.log(`Ученик:  http://localhost:${PORT}/student`);
  const nets=os.networkInterfaces(),addresses=[];
  for(const list of Object.values(nets))for(const n of list||[])if(n.family==='IPv4'&&!n.internal)addresses.push(n.address);
  if(addresses.length){console.log('\nЕсли телефоны и компьютер в одной Wi‑Fi сети:');for(const a of addresses)console.log(`http://${a}:${PORT}/student`);}
});
