import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function KnowledgeText({text,className=''}:{text:string;className?:string}):JSX.Element {
  const source=useRef<HTMLSpanElement>(null);
  const overlay=useRef<HTMLSpanElement>(null);
  const dismissed=useRef(false);
  const hoverTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const cancelHover=()=>{if(hoverTimer.current!==null){clearTimeout(hoverTimer.current);hoverTimer.current=null;}};
  useEffect(()=>{
    const cancel=()=>cancelHover();
    window.addEventListener('blur',cancel);
    document.addEventListener('scroll',cancel,true);
    document.addEventListener('pointerdown',cancel,true);
    return ()=>{cancelHover();window.removeEventListener('blur',cancel);document.removeEventListener('scroll',cancel,true);document.removeEventListener('pointerdown',cancel,true);};
  },[]);
  const [position,setPosition]=useState<{left:number;top:number;width:number}|null>(null);
  useEffect(()=>{
    if(!position)return;
    const close=()=>setPosition(null);
    const outside=(event:PointerEvent)=>{if(!overlay.current?.contains(event.target as Node))close();};
    const move=(event:PointerEvent)=>{
      const inside=[source.current,overlay.current].some(element=>{
        const rect=element?.getBoundingClientRect();
        return rect&&event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom;
      });
      if(!inside)close();
    };
    const leaveWindow=(event:PointerEvent)=>{if(!event.relatedTarget)close();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){dismissed.current=true;close();}};
    window.addEventListener('resize',close);
    window.addEventListener('blur',close);
    document.addEventListener('scroll',close,true);
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('pointermove',move,true);
    document.addEventListener('pointerout',leaveWindow,true);
    document.addEventListener('keydown',key);
    return ()=>{
      window.removeEventListener('resize',close);
      window.removeEventListener('blur',close);
      document.removeEventListener('scroll',close,true);
      document.removeEventListener('pointerdown',outside,true);
      document.removeEventListener('pointermove',move,true);
      document.removeEventListener('pointerout',leaveWindow,true);
      document.removeEventListener('keydown',key);
    };
  },[position]);
  return <>
    <span ref={source} className={`knowledge-inline-text ${className}`}
      onClick={event=>event.stopPropagation()}
      onMouseLeave={event=>{
        cancelHover();
        dismissed.current=false;
        if(!(event.relatedTarget instanceof Node)||!overlay.current?.contains(event.relatedTarget))setPosition(null);
      }}
      onMouseEnter={()=>{
        if(dismissed.current)return;
        cancelHover();
        hoverTimer.current=setTimeout(()=>{
          hoverTimer.current=null;
          const rect=source.current?.getBoundingClientRect();
          if(rect)setPosition({left:Math.max(8,rect.left),top:rect.top,width:Math.min(rect.width,window.innerWidth-rect.left-12)});
        },1000);
      }}>{text}</span>
    {position&&createPortal(
      <span ref={overlay} className={`knowledge-expanded-text ${className}`} role="note" aria-label="完整文本"
        style={{left:position.left,top:position.top,width:Math.min(Math.max(position.width,280),560,window.innerWidth-position.left-12),maxWidth:Math.max(80,window.innerWidth-position.left-12)}}
        onClick={event=>event.stopPropagation()} onPointerDown={event=>event.stopPropagation()}
        onMouseLeave={()=>setPosition(null)}>{text}</span>,document.body)}
  </>;
}
