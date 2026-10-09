import {useState, type ReactNode} from 'react';
import '../library-interactions.css';

/** Give in-page folder navigation the same direction as the app's screen history. */
export function LibraryPane({viewKey,depth,children,className=''}:{viewKey:string;depth:number;children:ReactNode;className?:string}) {
  const [entry,setEntry]=useState({key:viewKey,depth,direction:'none'});
  let current=entry;
  if(entry.key!==viewKey){
    current={key:viewKey,depth,direction:depth<entry.depth?'back':depth>entry.depth?'forward':'replace'};
    setEntry(current);
  }
  return <div key={viewKey} className={`library-pane library-pane--${current.direction} ${className}`}>{children}</div>;
}
