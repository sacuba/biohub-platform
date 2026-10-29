import {config} from './config';
import type {Tool} from './generated/platform';
export function tools():Tool[]{return [
 {id:'yinglan',name:'Yinglan 科研生图',category:'科研绘图',description:'将科研构想转化为图像。支持文字生图、参考图生成和局部修图。',status:'available',url:config.yinglanUrl+'/api/platform/login',capabilities:['generation','edit'],contract_version:'0.1.0'},
 {id:'sequence',name:'序列格式转换',category:'序列工具',description:'在 FASTA、FASTQ 等常见格式之间转换，让数据准备更简单。',status:'coming_soon',capabilities:[],contract_version:'0.1.0'},
 {id:'quality',name:'序列质量检查',category:'序列工具',description:'检查测序数据质量，发现异常分布与潜在问题。',status:'coming_soon',capabilities:[],contract_version:'0.1.0'},
 {id:'enrichment',name:'功能富集分析',category:'功能分析',description:'探索基因集背后的生物学过程、通路与功能关联。',status:'coming_soon',capabilities:[],contract_version:'0.1.0'},
 {id:'rnaseq',name:'RNA-seq 分析',category:'组学分析',description:'连接表达定量、差异分析和下游探索的科研流程。',status:'coming_soon',capabilities:[],contract_version:'0.1.0'},
 {id:'visualization',name:'科研数据可视化',category:'科研绘图',description:'将研究数据绘制为清晰、易读的科学图表。',status:'coming_soon',capabilities:[],contract_version:'0.1.0'}
 ];}
