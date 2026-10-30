import type {Metadata} from 'next';
import './globals.css';
import {themeInitialization} from './theme';
export const metadata:Metadata={title:'BioHub · 生信工具平台',description:'统一入口，连接你的生物信息学研究工具。'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:themeInitialization}}/></head><body>{children}</body></html>;}
