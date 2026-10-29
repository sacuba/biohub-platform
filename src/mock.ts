import express from 'express';
import type {Express} from 'express';
import sharp from 'sharp';
import {config} from './config';
export function setupMock(app:Express){
 if(process.env.DEV_MOCK_IMAGES!=='true'||process.env.NODE_ENV==='production')return;
 app.use('/dev-image-api',express.json({limit:'20mb'}),express.raw({type:'multipart/form-data',limit:'32mb'}));
 app.use('/dev-image-api',(req,res,next)=>{if(!config.mockSecret||req.headers.authorization!=='Bearer '+config.mockSecret){res.status(401).json({error:{message:'Mock access denied'}});return;}next();});
 app.get('/dev-image-api/v1/models',(_req,res)=>res.json({data:[{id:'biohub-dev-image-mock'}]}));
 for(const route of ['generations','edits'])app.post('/dev-image-api/v1/images/'+route,async(req,res)=>{
 let prompt=String(req.body?.prompt||'');
 if(Buffer.isBuffer(req.body)){const form=await new Response(new Uint8Array(req.body),{headers:{'Content-Type':req.headers['content-type']||''}}).formData();prompt=String(form.get('prompt')||'');}
 await new Promise(r=>setTimeout(r,prompt.includes('SLOW')?5000:1000));
 if(prompt.includes('FAIL')){res.status(500).json({error:{message:'Controlled development failure'}});return;}
 const circles=Array.from({length:24},(_,i)=>{const a=i/24*Math.PI*2;return `<circle cx="${512+Math.cos(a)*175}" cy="${320+Math.sin(a)*175}" r="12" fill="#5cb7ab"/>`;}).join('');
 const svg=`<svg width="1024" height="640" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="g"><stop stop-color="#9ce5d7"/><stop offset="1" stop-color="#237f84"/></radialGradient></defs><rect width="1024" height="640" fill="#eff8f6"/><circle cx="512" cy="320" r="150" fill="url(#g)"/>${circles}<circle cx="490" cy="305" r="60" fill="#c7b8ef"/><circle cx="550" cy="340" r="27" fill="#f0ce83"/><text x="40" y="55" font-family="sans-serif" font-size="24" fill="#153e48">BIOHUB · DEVELOPMENT MOCK</text><text x="40" y="594" font-family="sans-serif" font-size="20" fill="#456671">Local integration preview / no paid model call</text></svg>`;
 const png=await sharp(Buffer.from(svg)).png().toBuffer();res.json({data:[{b64_json:png.toString('base64')}],model:'biohub-dev-image-mock'});
 });
}
