const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const QUIZZES_FILE = path.join(DATA_DIR, 'quizzes.json');
const AVATARS = ['🦊','🐼','🐯','🐸','🐵','🐰','🐨','🦁','🐧','🐙','🦄','🤖','🐶','🐱','🐭','🐹','🐻','🐮','🐷','🐔','🦉','🐝','🐢','🐬'];

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(QUIZZES_FILE)) fs.writeFileSync(QUIZZES_FILE, '[]', 'utf8');

const rooms = new Map();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml'
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store, no-cache, must-revalidate', 'pragma': 'no-cache', 'expires': '0' });
  res.end(body);
}
function text(res, status, body, type='text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store, no-cache, must-revalidate', 'pragma': 'no-cache', 'expires': '0' });
  res.end(body);
}
async function readBody(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 15_000_000) throw new Error('too-large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('bad-json'); }
}
function readQuizzes(){ try{return JSON.parse(fs.readFileSync(QUIZZES_FILE,'utf8'));}catch{return [];} }
function writeQuizzes(q){ fs.writeFileSync(QUIZZES_FILE,JSON.stringify(q,null,2),'utf8'); }
function id(prefix=''){ return prefix + crypto.randomBytes(8).toString('hex'); }
function shuffle(a){ a=[...a]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function cleanAvatarReservations(room){
  const now=Date.now();
  if(!room.avatarReservations) room.avatarReservations=new Map();
  for(const [avatar,r] of room.avatarReservations) if(!r || r.expiresAt<=now) room.avatarReservations.delete(avatar);
}
function unavailableAvatars(room,ownToken=''){
  cleanAvatarReservations(room);
  const used=new Set([...room.participants.values()].map(p=>p.avatar));
  for(const [avatar,r] of room.avatarReservations) if(!ownToken || r.token!==ownToken) used.add(avatar);
  return [...used];
}
function numberValue(value){
  if(typeof value==='number' && Number.isFinite(value)) return value;
  if(typeof value!=='string') return null;
  const s=value.trim().replace(',','.');
  if(!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)) return null;
  const n=Number(s); return Number.isFinite(n)?n:null;
}
function cleanImageData(value){
  if(!value) return '';
  const data=String(value);
  if(!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) throw new Error('Изображение в вопросе имеет неподдерживаемый формат');
  if(data.length>1_500_000) throw new Error('Изображение слишком большое. Уменьшите его перед загрузкой');
  return data;
}
function cleanQuiz(body){
  const title=String(body.title||'').trim(); const qs=Array.isArray(body.questions)?body.questions:[];
  if(!title || !qs.length) throw new Error('Нужно название и хотя бы один вопрос');
  const questions=qs.map(src=>{
    const qtext=String(src.text||'').trim();
    const imageData=cleanImageData(src.imageData||'');
    if(src.type!=='sentence' && !qtext && !imageData) throw new Error('В каждом вопросе нужен текст или изображение');
    if(src.type==='choice'){
      const options=Array.isArray(src.options)?src.options.map(x=>String(x).trim()).filter(Boolean):[];
      if(options.length<2) throw new Error('В вопросе с выбором должно быть минимум 2 варианта');
      const ci=Number(src.correctIndex); if(!Number.isInteger(ci)||ci<0||ci>=options.length) throw new Error('Укажите правильный вариант ответа');
      return {id:src.id||id('q_'),type:'choice',text:qtext,imageData,options,correctIndex:ci};
    }
    if(src.type==='number'){
      const n=numberValue(String(src.correctAnswer??'')); if(n===null) throw new Error('Числовой ответ должен быть целым числом или конечной десятичной дробью');
      return {id:src.id||id('q_'),type:'number',text:qtext,imageData,correctAnswer:n};
    }
    if(src.type==='sentence'){
      const tokens=Array.isArray(src.tokens)?src.tokens.map(x=>String(x).trim()).filter(Boolean):[];
      if(tokens.length<2) throw new Error('В задании «Составь предложение» нужно минимум 2 плашки');
      return {id:src.id||id('q_'),type:'sentence',text:qtext,imageData,tokens};
    }
    if(src.type==='splitmul'){
      const leftNumber=Number(src.leftNumber), multiplier=Number(src.multiplier), tens=Number(src.tens), ones=Number(src.ones);
      const parts=Array.isArray(src.correctParts)?src.correctParts.map(Number):[];
      if(!Number.isInteger(leftNumber)||leftNumber<10||leftNumber>99) throw new Error('Некорректное двузначное число в задании по распределительному закону');
      if(!Number.isInteger(multiplier)||multiplier<2||multiplier>9) throw new Error('Некорректный однозначный множитель');
      if(tens!==Math.floor(leftNumber/10)*10 || ones!==leftNumber%10) throw new Error('Некорректное разложение двузначного числа');
      if(parts.length!==3 || parts.some(x=>!Number.isFinite(x))) throw new Error('Некорректные ответы в задании по распределительному закону');
      const expected=[tens*multiplier,ones*multiplier,leftNumber*multiplier];
      if(parts.some((x,i)=>Math.abs(x-expected[i])>1e-12)) throw new Error('Некорректные ответы в задании по распределительному закону');
      return {id:src.id||id('q_'),type:'splitmul',text:qtext||`${leftNumber} · ${multiplier}`,imageData,leftNumber,multiplier,tens,ones,correctParts:expected};
    }
    throw new Error('Неизвестный тип вопроса');
  });
  return {id:body.id||id('quiz_'),title,questions,updatedAt:new Date().toISOString()};
}
function makeStudentQuestions(room,p){
  return p.order.map((qi,pos)=>{
    const q=room.quiz.questions[qi];
    if(q.type==='choice') return {id:q.id,number:pos+1,type:'choice',text:q.text,imageData:q.imageData||'',options:p.optionOrders[qi].map(oi=>({key:oi,text:q.options[oi]}))};
    if(q.type==='sentence') return {id:q.id,number:pos+1,type:'sentence',text:q.text,imageData:q.imageData||'',tokens:p.optionOrders[qi].map(oi=>({key:oi,text:q.tokens[oi]}))};
    if(q.type==='splitmul') return {id:q.id,number:pos+1,type:'splitmul',text:q.text,imageData:q.imageData||'',leftNumber:q.leftNumber,multiplier:q.multiplier,tens:q.tens,ones:q.ones};
    return {id:q.id,number:pos+1,type:'number',text:q.text,imageData:q.imageData||''};
  });
}
function participantElapsedMs(room,p){
  if(!p.startedAt) return 0;
  const end=p.finishedAt || room.closedAt || Date.now();
  return Math.max(0,end-p.startedAt);
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
    score:p.answers.filter(a=>a.correct).length*1000,
    finished:p.finished,
    joinedAt:p.joinedAt,
    startedAt:p.startedAt||null,
    finishedAt:p.finishedAt||null,
    elapsedMs:participantElapsedMs(room,p)
  }));
  if(room.status==='active' || room.status==='closed'){
    items.sort((a,b)=>b.correct-a.correct || a.joinedAt-b.joinedAt || a.name.localeCompare(b.name,'ru'));
    const levels=[...new Set(items.filter(x=>x.correct>0).map(x=>x.correct))].sort((a,b)=>b-a);
    return items.map(p=>({
      ...p,
      rank:p.correct>0 ? levels.indexOf(p.correct)+1 : null,
      awardEligible:p.correct>0
    }));
  }
  items.sort((a,b)=>a.joinedAt-b.joinedAt);
  return items.map(p=>({...p,rank:null,awardEligible:false}));
}
function roomState(room){
  const reportReady=room.status==='closed' || allParticipantsFinished(room);
  return {
    roomId:room.id,
    quizTitle:room.quiz.title,
    status:room.status,
    totalQuestions:room.quiz.questions.length,
    participantCount:room.participants.size,
    ratingVisible:room.ratingVisible!==false,
    namesVisible:room.namesVisible!==false,
    participants:leaderboard(room),
    reportReady,
    report:reportReady?makeReport(room):null
  };
}
function rankFor(room,participantId){
  const board=leaderboard(room); const item=board.find(x=>x.id===participantId);
  return {rank:item?.rank??null,totalPlayers:board.length,correct:item?.correct||0};
}
function pointsForAnswer(correct){ return correct ? 1000 : 0; }
function displayNumber(value){
  if(typeof value!=='number' || !Number.isFinite(value)) return String(value??'');
  return String(value).replace('.',',');
}
function answerTextForReport(q, answer){
  if(q.type==='choice'){
    const i=Number(answer);
    return Number.isInteger(i) && q.options[i]!==undefined ? q.options[i] : '—';
  }
  if(q.type==='sentence'){
    if(!Array.isArray(answer)) return '—';
    return answer.map(i=>q.tokens[Number(i)] ?? '—').join(' ');
  }
  if(q.type==='splitmul'){
    if(!answer || typeof answer!=='object') return '—';
    return `${displayNumber(answer.part1)} + ${displayNumber(answer.part2)} = ${displayNumber(answer.result)}`;
  }
  return displayNumber(answer);
}
function correctTextForReport(q){
  if(q.type==='choice') return q.options[q.correctIndex] ?? '—';
  if(q.type==='sentence') return q.tokens.join(' ');
  if(q.type==='splitmul') return `${displayNumber(q.correctParts[0])} + ${displayNumber(q.correctParts[1])} = ${displayNumber(q.correctParts[2])}`;
  return displayNumber(q.correctAnswer);
}
function makeReport(room){
  const total=room.quiz.questions.length;
  const participants=[...room.participants.values()]
    .sort((a,b)=>a.joinedAt-b.joinedAt || a.name.localeCompare(b.name,'ru'))
    .map(p=>{
      const correct=p.answers.filter(a=>a.correct).length;
      const wrongAnswers=p.answers.filter(a=>!a.correct);
      const details=p.order.map((qi,position)=>{
        const q=room.quiz.questions[qi];
        const a=p.answers[position]||null;
        if(!q) return {number:position+1,questionText:'Вопрос не найден',hasImage:false,imageData:'',status:'unanswered',studentAnswer:'—',correctAnswer:'—'};
        return {
          number:position+1,
          questionText:q.text || (q.imageData?'Задание с изображением':`Задание ${position+1}`),
          hasImage:Boolean(q.imageData),
          imageData:q.imageData||'',
          status:a ? (a.correct?'correct':'wrong') : 'unanswered',
          correct:a ? Boolean(a.correct) : null,
          studentAnswer:a ? answerTextForReport(q,a.answer) : '—',
          correctAnswer:correctTextForReport(q)
        };
      });
      const errors=details.filter(x=>x.status==='wrong').map(x=>({
        questionNumber:x.number,questionText:x.questionText,hasImage:x.hasImage,
        studentAnswer:x.studentAnswer,correctAnswer:x.correctAnswer
      }));
      return {
        id:p.id,name:p.name,avatar:p.avatar,
        answered:p.answers.length,total,
        correct,wrong:wrongAnswers.length,
        unanswered:Math.max(0,total-p.answers.length),
        finished:p.finished,
        durationMs:participantElapsedMs(room,p),
        details,errors
      };
    });
  return {quizTitle:room.quiz.title,totalQuestions:total,participantCount:participants.length,status:room.status,participants};
}
function allParticipantsFinished(room){
  return room.participants.size>0 && [...room.participants.values()].every(p=>p.finished);
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
    res.writeHead(200,{'content-type':MIME[path.extname(file)]||'application/octet-stream','cache-control':'no-store, no-cache, must-revalidate','pragma':'no-cache','expires':'0'});
    res.end(data);
  });
}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`); const pathname=decodeURIComponent(u.pathname);
  try{
    if(req.method==='GET' && pathname==='/api/version') return json(res,200,{version:'3.8',updated:'2026-10-01'});
    if(req.method==='GET' && pathname==='/api/qr'){
      const target=String(u.searchParams.get('text')||'').trim();
      if(!target || target.length>2000) return json(res,400,{error:'Некорректная ссылка для QR-кода'});
      const svg=await QRCode.toString(target,{type:'svg',errorCorrectionLevel:'M',margin:2,width:360});
      res.writeHead(200,{'content-type':'image/svg+xml; charset=utf-8','cache-control':'no-store'});res.end(svg);return;
    }
    if(req.method==='GET' && pathname==='/api/quizzes') return json(res,200,readQuizzes().map(q=>({id:q.id,title:q.title,questionCount:q.questions.length,updatedAt:q.updatedAt})));
    let m=pathname.match(/^\/api\/quizzes\/([^/]+)$/);
    if(m && req.method==='GET'){const q=readQuizzes().find(x=>x.id===m[1]);return q?json(res,200,q):json(res,404,{error:'Викторина не найдена'});}
    if(pathname==='/api/quizzes' && req.method==='POST'){
      const body=await readBody(req); let q; try{q=cleanQuiz(body);}catch(e){return json(res,400,{error:e.message});}
      const all=readQuizzes(); const i=all.findIndex(x=>x.id===q.id); if(i>=0)all[i]=q;else all.push(q);writeQuizzes(all);return json(res,200,q);
    }
    if(m && req.method==='DELETE'){writeQuizzes(readQuizzes().filter(x=>x.id!==m[1]));return json(res,200,{ok:true});}

    // Постоянная ссылка каждой викторины ведёт на её текущую открытую комнату.
    // Пользовательские коды подключения отключены: ученики входят только по ссылке викторины.
    m=pathname.match(/^\/api\/quiz-room\/([^/]+)$/);
    if(m && req.method==='GET'){
      const quizId=m[1];
      const candidates=[...rooms.values()]
        .filter(room=>room.status!=='closed' && room.quiz?.id===quizId)
        .sort((a,b)=>b.createdAt-a.createdAt);
      const room=candidates[0];
      if(!room) return json(res,404,{error:'Учитель ещё не открыл эту викторину'});
      const reservationToken=String(u.searchParams.get('reservationToken')||'');
      return json(res,200,{roomId:room.id,quizTitle:room.quiz.title,status:room.status,questionCount:room.quiz.questions.length,usedAvatars:unavailableAvatars(room,reservationToken)});
    }

    // Создание комнаты теперь создаёт ЛОББИ. Викторина начинается только после кнопки «Старт» у учителя.
    if(pathname==='/api/rooms' && req.method==='POST'){
      const body=await readBody(req);
      let quiz;
      try {
        if (body.quiz) quiz=cleanQuiz(body.quiz);
        else if (body.quizId) quiz=readQuizzes().find(q=>q.id===body.quizId);
        if(!quiz) return json(res,404,{error:'Викторина не найдена'});
      } catch(e) { return json(res,400,{error:e.message}); }
      const roomId=id('r_'),teacherToken=id('t_');
      rooms.set(roomId,{id:roomId,teacherToken,quiz,status:'lobby',ratingVisible:true,namesVisible:true,createdAt:Date.now(),startedAt:null,closedAt:null,participants:new Map(),avatarReservations:new Map(),listeners:new Set()});
      return json(res,200,{roomId,teacherToken,quizTitle:quiz.title,quizId:quiz.id,status:'lobby'});
    }

    m=pathname.match(/^\/api\/rooms\/([^/]+)$/);
    if(m && req.method==='GET'){
      const room=rooms.get(m[1]);
      if(!room||room.status==='closed')return json(res,404,{error:'Комната не найдена или уже закрыта'});
      const reservationToken=String(u.searchParams.get('reservationToken')||'');
      return json(res,200,{roomId:room.id,quizTitle:room.quiz.title,status:room.status,questionCount:room.quiz.questions.length,usedAvatars:unavailableAvatars(room,reservationToken)});
    }

    m=pathname.match(/^\/api\/rooms\/([^/]+)\/events$/);
    if(m && req.method==='GET'){
      const room=rooms.get(m[1]);if(!room||u.searchParams.get('token')!==room.teacherToken)return text(res,403,'Нет доступа');
      res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache','connection':'keep-alive','access-control-allow-origin':'*'});
      res.write(`data: ${JSON.stringify(roomState(room))}\n\n`);
      room.listeners.add(res);req.on('close',()=>room.listeners.delete(res));return;
    }

    // Резервирование персонажа происходит уже при нажатии на иконку на стартовой странице.
    m=pathname.match(/^\/api\/rooms\/([^/]+)\/avatar-reserve$/);
    if(m && req.method==='POST'){
      const room=rooms.get(m[1]);
      if(!room||room.status==='closed')return json(res,404,{error:'Комната не найдена или уже закрыта'});
      const body=await readBody(req);
      const avatar=String(body.avatar||'');
      if(!AVATARS.includes(avatar))return json(res,400,{error:'Выберите персонажа'});
      cleanAvatarReservations(room);
      let token=String(body.reservationToken||'').trim();
      if(!token) token=id('a_');
      for(const [a,r] of room.avatarReservations) if(r?.token===token && a!==avatar) room.avatarReservations.delete(a);
      const occupied=[...room.participants.values()].some(p=>p.avatar===avatar);
      const existing=room.avatarReservations.get(avatar);
      if(occupied || (existing && existing.token!==token)) return json(res,409,{error:'Этот персонаж уже выбран другим учеником.',avatarTaken:true,usedAvatars:unavailableAvatars(room,token)});
      room.avatarReservations.set(avatar,{token,expiresAt:Date.now()+5*60*1000});
      return json(res,200,{ok:true,reservationToken:token,avatar,usedAvatars:unavailableAvatars(room,token)});
    }

    // Подключаться можно и в лобби, и после старта — до тех пор, пока учитель не завершит игру.
    m=pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
    if(m && req.method==='POST'){
      const room=rooms.get(m[1]);
      if(!room||room.status==='closed')return json(res,404,{error:'Комната не найдена или уже закрыта'});
      const body=await readBody(req);
      const name=String(body.name||'').trim().slice(0,40);if(!name)return json(res,400,{error:'Введите имя'});
      const avatar=AVATARS.includes(body.avatar)?body.avatar:'';
      if(!avatar)return json(res,400,{error:'Выберите персонажа'});
      cleanAvatarReservations(room);
      const reservationToken=String(body.reservationToken||'').trim();
      const usedAvatars=[...room.participants.values()].map(p=>p.avatar);
      if(usedAvatars.includes(avatar)) return json(res,409,{error:'Этот персонаж уже выбран другим учеником. Выберите свободного персонажа.',avatarTaken:true,usedAvatars:unavailableAvatars(room,reservationToken)});
      const reservation=room.avatarReservations.get(avatar);
      if(reservation && reservation.token!==reservationToken) return json(res,409,{error:'Этот персонаж уже выбран другим учеником. Выберите свободного персонажа.',avatarTaken:true,usedAvatars:unavailableAvatars(room,reservationToken)});
      if(reservation && reservation.token===reservationToken) room.avatarReservations.delete(avatar);
      for(const [a,r] of room.avatarReservations) if(r?.token===reservationToken) room.avatarReservations.delete(a);
      const now=Date.now();
      const p={
        id:id('p_'),name,avatar,joinedAt:now,
        order:shuffle(room.quiz.questions.map((_,i)=>i)),optionOrders:{},answers:[],current:0,
        finished:false,score:0,totalResponseMs:0,
        startedAt:room.status==='active'?now:null,finishedAt:null,
        questionStartedAt:room.status==='active'?now:null
      };
      room.quiz.questions.forEach((q,i)=>{if(q.type==='choice')p.optionOrders[i]=shuffle(q.options.map((_,j)=>j)); else if(q.type==='sentence')p.optionOrders[i]=shuffle(q.tokens.map((_,j)=>j));});
      room.participants.set(p.id,p);
      broadcast(room);
      const place=rankFor(room,p.id);
      return json(res,200,{
        participantId:p.id,quizTitle:room.quiz.title,questions:makeStudentQuestions(room,p),
        roomStatus:room.status,rank:place.rank,totalPlayers:room.participants.size,avatar:p.avatar,ratingVisible:room.ratingVisible!==false,usedAvatars:unavailableAvatars(room,'')
      });
    }

    // Только учитель запускает викторину.
    m=pathname.match(/^\/api\/rooms\/([^/]+)\/start$/);
    if(m && req.method==='POST'){
      const room=rooms.get(m[1]);if(!room)return json(res,404,{error:'Комната не найдена'});
      const body=await readBody(req);if(body.teacherToken!==room.teacherToken)return json(res,403,{error:'Нет доступа'});
      if(room.status==='closed')return json(res,410,{error:'Викторина уже завершена'});
      if(room.status==='active')return json(res,200,{ok:true,status:'active'});
      room.status='active';room.startedAt=Date.now();
      for(const p of room.participants.values()) if(!p.finished){ p.startedAt=room.startedAt; p.questionStartedAt=room.startedAt; }
      broadcast(room);
      return json(res,200,{ok:true,status:'active'});
    }

    m=pathname.match(/^\/api\/rooms\/([^/]+)\/answer$/);
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
      }else if(q.type==='sentence'){
        if(!Array.isArray(answer)) return json(res,400,{error:'Составьте утверждение из всех плашек',invalid:true});
        answer=answer.map(Number);
        const expected=q.tokens.map((_,i)=>i);
        correct=answer.length===expected.length && answer.every((v,i)=>Number.isInteger(v)&&v===expected[i]);
      }else if(q.type==='splitmul'){
        if(!answer || typeof answer!=='object' || Array.isArray(answer)) return json(res,400,{error:'Заполните все три окна ответа',invalid:true});
        const part1=numberValue(String(answer.part1??''));
        const part2=numberValue(String(answer.part2??''));
        const result=numberValue(String(answer.result??''));
        if(part1===null||part2===null||result===null) return json(res,400,{error:'Заполните все три окна числами',invalid:true});
        answer={part1,part2,result};
        correct=Math.abs(part1-q.correctParts[0])<1e-12 && Math.abs(part2-q.correctParts[1])<1e-12 && Math.abs(result-q.correctParts[2])<1e-12;
      }else{
        answer=numberValue(String(answer??''));
        if(answer===null)return json(res,400,{error:'Введите целое число или конечную десятичную дробь',invalid:true});
        correct=Math.abs(answer-q.correctAnswer)<1e-12;
      }
      const answeredAt=Date.now();
      const responseMs=Math.max(0,answeredAt-(p.questionStartedAt||answeredAt));
      const pointsEarned=pointsForAnswer(correct);
      p.score=(p.score||0)+pointsEarned;
      p.totalResponseMs=(p.totalResponseMs||0)+responseMs;
      p.answers.push({questionId:q.id,answer,correct,points:pointsEarned,responseMs,at:answeredAt});
      p.current++;
      if(p.current>=p.order.length){p.finished=true;p.finishedAt=answeredAt;} else p.questionStartedAt=answeredAt;
      const place=rankFor(room,p.id);
      broadcast(room);
      return json(res,200,{correct,finished:p.finished,answered:p.answers.length,total:p.order.length,correctCount:p.answers.filter(a=>a.correct).length,pointsEarned,score:p.score,rank:place.rank,totalPlayers:place.totalPlayers,ratingVisible:room.ratingVisible!==false});
    }

    m=pathname.match(/^\/api\/rooms\/([^/]+)\/status$/);
    if(m && req.method==='GET'){
      const room=rooms.get(m[1]); if(!room||room.status==='closed')return json(res,410,{status:'closed'});
      const participantId=u.searchParams.get('participantId');
      if(participantId){
        const p=room.participants.get(participantId); if(!p)return json(res,404,{error:'Участник не найден'});
        const place=rankFor(room,p.id);
        return json(res,200,{
          status:room.status,rank:place.rank,totalPlayers:place.totalPlayers,score:p.answers.filter(a=>a.correct).length*1000,
          ratingVisible:room.ratingVisible!==false,
          correct:p.answers.filter(a=>a.correct).length,answered:p.answers.length,total:room.quiz.questions.length,
          finished:p.finished,avatar:p.avatar,name:p.name,elapsedMs:participantElapsedMs(room,p)
        });
      }
      return json(res,200,{status:room.status,participantCount:room.participants.size});
    }

    m=pathname.match(/^\/api\/rooms\/([^/]+)\/rating-visibility$/);
    if(m && req.method==='POST'){
      const room=rooms.get(m[1]);if(!room)return json(res,404,{error:'Комната не найдена'});
      const body=await readBody(req);if(body.teacherToken!==room.teacherToken)return json(res,403,{error:'Нет доступа'});
      room.ratingVisible=Boolean(body.visible);
      broadcast(room);
      return json(res,200,{ok:true,ratingVisible:room.ratingVisible});
    }

    m=pathname.match(/^\/api\/rooms\/([^/]+)\/names-visibility$/);
    if(m && req.method==='POST'){
      const room=rooms.get(m[1]);if(!room)return json(res,404,{error:'Комната не найдена'});
      const body=await readBody(req);if(body.teacherToken!==room.teacherToken)return json(res,403,{error:'Нет доступа'});
      room.namesVisible=Boolean(body.visible);
      broadcast(room);
      return json(res,200,{ok:true,namesVisible:room.namesVisible});
    }

    m=pathname.match(/^\/api\/rooms\/([^/]+)\/report$/);
    if(m && req.method==='GET'){
      const room=rooms.get(m[1]);if(!room)return json(res,404,{error:'Комната не найдена'});
      if(u.searchParams.get('token')!==room.teacherToken)return json(res,403,{error:'Нет доступа'});
      return json(res,200,{report:makeReport(room)});
    }

    m=pathname.match(/^\/api\/rooms\/([^/]+)\/close$/);
    if(m && req.method==='POST'){
      const room=rooms.get(m[1]);if(!room)return json(res,404,{error:'Комната не найдена'});
      const body=await readBody(req);if(body.teacherToken!==room.teacherToken)return json(res,403,{error:'Нет доступа'});
      room.status='closed';room.closedAt=Date.now();
      const report=makeReport(room);
      broadcast(room);
      setTimeout(()=>closeSse(room),1500);
      setTimeout(()=>rooms.delete(room.id),12*60*60*1000);
      return json(res,200,{ok:true,report});
    }

    if(req.method==='GET'){
      if(pathname==='/') return serveFile(res,path.join(PUBLIC_DIR,'index.html'));
      if(pathname==='/teacher') return serveFile(res,path.join(PUBLIC_DIR,'teacher.html'));
      if(pathname==='/student') return serveFile(res,path.join(PUBLIC_DIR,'student.html'));
      if(pathname==='/overview') return serveFile(res,path.join(PUBLIC_DIR,'overview.html'));
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
  console.log('Ученики входят по постоянной ссылке конкретной викторины из кабинета учителя.');
  const nets=os.networkInterfaces(),addresses=[];
  for(const list of Object.values(nets))for(const n of list||[])if(n.family==='IPv4'&&!n.internal)addresses.push(n.address);
  if(addresses.length){console.log('\nДля локальной проверки ссылка ученика формируется в кабинете учителя после создания викторины.');}
});
