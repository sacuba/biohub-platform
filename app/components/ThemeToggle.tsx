'use client';
import {useEffect,useState} from 'react';
import {Moon,Sun} from 'lucide-react';

export default function ThemeToggle(){
 const [theme,setTheme]=useState('light');
 useEffect(()=>{
  const sync=()=>setTheme(document.documentElement.dataset.theme||'light');sync();
  const system=matchMedia('(prefers-color-scheme: dark)');
  const update=()=>{try{if(!localStorage.getItem('biohub-theme')){document.documentElement.dataset.theme=system.matches?'dark':'light';sync();}}catch{/* Keep the active theme when browser storage is unavailable. */}};
  const storage=(event:StorageEvent)=>{if(event.key!=='biohub-theme'&&event.key!==null)return;document.documentElement.dataset.theme=event.newValue==='dark'?'dark':event.newValue==='light'?'light':system.matches?'dark':'light';sync();};
  system.addEventListener('change',update);window.addEventListener('storage',storage);update();
  return()=>{system.removeEventListener('change',update);window.removeEventListener('storage',storage);};
 },[]);
 function toggle(){const next=theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;setTheme(next);try{localStorage.setItem('biohub-theme',next);}catch{/* Switching still works for this page if storage is disabled. */}}
 return <button className="themeToggle" type="button" aria-label={theme==='dark'?'切换浅色模式':'切换深色模式'} title={theme==='dark'?'切换浅色模式':'切换深色模式'} onClick={toggle}><Sun className="themeSun" size={17}/><Moon className="themeMoon" size={17}/><span>{theme==='dark'?'浅色模式':'深色模式'}</span></button>;
}
