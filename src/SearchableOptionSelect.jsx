import { useEffect, useRef, useState } from "react";

export default function SearchableOptionSelect({
  options = [], value = "", onChange, placeholder = "Type to search…",
  ariaLabel = "Search options", className = "input input--select",
  style = {}, disabled = false, clearLabel = "Clear selection",
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef(null);
  const selected = options.find(option => String(option.value) === String(value));
  const normalized = query.trim().toLowerCase();
  const filtered = options.filter(option =>
    `${option.label ?? ""} ${option.searchText ?? ""}`.toLowerCase().includes(normalized)
  );

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = event => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const choose = option => {
    onChange(option ? option.value : "");
    setQuery("");
    setOpen(false);
    setActiveIndex(0);
  };

  return (
    <div ref={rootRef} style={{position:"relative",minWidth:0,width:"100%"}}>
      <div style={{position:"relative",display:"flex",alignItems:"center"}}>
        <input
          className={className}
          style={{width:"100%",minWidth:0,boxSizing:"border-box",paddingRight:selected && !disabled ? 36 : undefined,...style}}
          value={open ? query : (selected?.label ?? "")}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          role="combobox"
          disabled={disabled}
          autoComplete="off"
          onFocus={() => {setQuery("");setOpen(true);setActiveIndex(0);}}
          onChange={event => {setQuery(event.target.value);setOpen(true);setActiveIndex(0);}}
          onKeyDown={event => {
            if (event.key === "ArrowDown") {event.preventDefault();setOpen(true);setActiveIndex(i=>Math.min(i+1,Math.max(filtered.length-1,0)));}
            else if (event.key === "ArrowUp") {event.preventDefault();setActiveIndex(i=>Math.max(i-1,0));}
            else if (event.key === "Enter" && open && filtered.length) {event.preventDefault();choose(filtered[activeIndex] ?? filtered[0]);}
            else if (event.key === "Escape") {event.preventDefault();setOpen(false);setQuery("");}
          }}
        />
        {selected && !disabled && (
          <button type="button" aria-label={clearLabel} title={clearLabel}
            onMouseDown={event=>event.preventDefault()}
            onClick={()=>choose(null)}
            style={{position:"absolute",right:5,width:28,height:28,border:0,borderRadius:6,background:"transparent",color:"#9A9A9A",fontSize:20,lineHeight:"20px",cursor:"pointer"}}>
            ×
          </button>
        )}
      </div>
      {open && !disabled && (
        <div role="listbox" aria-label={ariaLabel}
          style={{position:"absolute",zIndex:100,top:"calc(100% + 4px)",left:0,right:0,maxHeight:240,overflowY:"auto",background:"#1C1C1C",border:"1px solid #3A3A3A",borderRadius:9,boxShadow:"0 8px 24px rgba(0,0,0,.35)"}}>
          {filtered.length ? filtered.map((option,index)=>(
            <button type="button" role="option" aria-selected={String(option.value)===String(value)} key={String(option.value)}
              onMouseDown={event=>event.preventDefault()}
              onMouseEnter={()=>setActiveIndex(index)}
              onClick={()=>choose(option)}
              style={{display:"block",width:"100%",textAlign:"left",padding:"10px 12px",border:0,borderBottom:"1px solid #2A2A2A",background:index===activeIndex?"#25372F":String(option.value)===String(value)?"#0B3D2E":"transparent",color:"#E0E0E0",fontSize:13,cursor:"pointer"}}>
              {option.label}
            </button>
          )) : <div style={{padding:"11px 12px",fontSize:12,color:"#8A8A8A"}}>No matching options</div>}
        </div>
      )}
    </div>
  );
}
