
import React from 'react';
import { Project } from '../types';

interface SidebarProps {
  projects: Project[];
  activeProjectId: string;
  onSelectProject: (id: string) => void;
  onAddProject: () => void;
  isOpen: boolean;
}

const Sidebar: React.FC<SidebarProps> = ({ projects, activeProjectId, onSelectProject, onAddProject, isOpen }) => {
  return (
    <aside className={`
      fixed inset-y-0 left-0 z-50 w-64 win-acrylic flex flex-col h-full border-r border-black/10 select-none transition-transform duration-200 ease-in-out
      md:static md:translate-x-0
      ${isOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}
    `}>
      {/* App Header */}
      <div className="h-12 flex items-center px-4 space-x-3 mb-2 shrink-0">
        <svg className="w-4 h-4 text-[#0078d4]" viewBox="0 0 24 24" fill="currentColor">
          <path d="M0 0h11.5v11.5H0V0zm12.5 0H24v11.5H12.5V0zM0 12.5h11.5V24H0V12.5zm12.5 0H24V24H12.5V12.5z"/>
        </svg>
        <span className="text-xs font-bold tracking-wide uppercase text-slate-600">VibeCloud Codex</span>
      </div>

      {/* Nav List */}
      <div className="flex-1 overflow-y-auto pt-2">
        <div className="px-4 py-2 text-[11px] font-bold text-slate-400 uppercase tracking-widest">
          Recent Projects
        </div>
        {projects.map((project) => (
          <button
            key={project.id}
            onClick={() => onSelectProject(project.id)}
            className={`w-full relative flex items-center px-4 py-3 win-item-hover transition-colors text-left ${
              activeProjectId === project.id ? 'bg-black/5' : ''
            }`}
          >
            {activeProjectId === project.id && <div className="win-active-bar" />}
            <span className={`text-sm truncate pl-2 ${activeProjectId === project.id ? 'font-semibold text-black' : 'font-normal text-slate-700'}`}>
              {project.name}
            </span>
          </button>
        ))}
      </div>

      {/* Footer Button */}
      <div className="p-4 border-t border-black/5 shrink-0">
        <button 
          onClick={onAddProject}
          className="w-full h-9 flex items-center justify-center space-x-2 bg-[#cccccc] hover:bg-[#bbbbbb] text-xs font-semibold text-black transition-all active:scale-[0.98] border border-black/10"
        >
          <span className="text-lg font-light">+</span>
          <span>New Project</span>
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
