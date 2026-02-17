
import React, { useState, useRef, useEffect } from 'react';
import { Message } from '../types';

interface AIPanelProps {
  projectName: string;
  onMenuClick: () => void;
}

const AIPanel: React.FC<AIPanelProps> = ({ projectName, onMenuClick }) => {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'ai', content: `[System]: Project "${projectName}" loaded successfully. Awaiting instructions.`, timestamp: new Date().toLocaleTimeString() }
  ]);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    const userMsg: Message = { role: 'user', content: input, timestamp: new Date().toLocaleTimeString() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');

    setTimeout(() => {
      const aiMsg: Message = { 
        role: 'ai', 
        content: `Executing vibe-command: "${input}"\nOutput: Neural sync complete. Vibe state optimized for ${projectName}.`, 
        timestamp: new Date().toLocaleTimeString() 
      };
      setMessages(prev => [...prev, aiMsg]);
    }, 800);
  };

  return (
    <div className="flex flex-col h-full bg-[#f9f9f9] w-full">
      {/* Mobile Top Header - Hidden on md (768px) and above */}
      <div className="h-12 border-b border-black/5 bg-white flex items-center px-4 justify-between md:hidden shrink-0">
        <button 
          onClick={onMenuClick}
          className="p-2 hover:bg-black/5 transition-colors"
          aria-label="Toggle projects"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="text-xs font-bold uppercase text-slate-600 truncate px-4">{projectName}</span>
        <div className="w-9" /> {/* Spacer */}
      </div>

      {/* Upper Area: Output */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4" ref={scrollRef}>
        <div className="max-w-5xl mx-auto space-y-4">
          {messages.map((msg, i) => (
            <div key={i} className="animate-in fade-in duration-300">
              <div className={`p-4 border shadow-sm ${
                msg.role === 'user' 
                ? 'bg-[#e1e1e1] border-black/5 ml-4 md:ml-12' 
                : 'bg-[#ffffff] border-black/10 mr-4 md:mr-12'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-[10px] font-bold uppercase tracking-widest ${msg.role === 'user' ? 'text-[#0078d4]' : 'text-slate-500'}`}>
                    {msg.role === 'user' ? 'User Instruction' : 'AI Output'}
                  </span>
                  <span className="text-[9px] text-slate-400 font-mono">{msg.timestamp}</span>
                </div>
                <div className="text-sm font-normal leading-relaxed whitespace-pre-wrap text-black">
                  {msg.content}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Lower Area: Input */}
      <div className="p-4 md:p-6 bg-[#ffffff] border-t border-black/10 shrink-0">
        <div className="max-w-5xl mx-auto flex flex-col space-y-3">
          <div className="relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={`Send command to ${projectName}...`}
              className="win-input w-full p-3 md:p-4 text-sm text-black min-h-[60px] md:min-h-[80px] max-h-[150px] resize-none"
              rows={2}
            />
            <div className="mt-2 flex items-center justify-between md:justify-end md:space-x-4 md:absolute md:right-3 md:bottom-3">
               <span className="text-[10px] text-slate-400 font-semibold uppercase hidden md:inline">Ctrl + Enter to send</span>
               <button 
                onClick={handleSend}
                className="win-button-accent w-full md:w-auto px-6 py-2 text-xs font-semibold uppercase tracking-wider shadow-sm active:scale-95 transition-transform"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AIPanel;
