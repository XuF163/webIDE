
import React, { useState } from 'react';
import Sidebar from './components/Sidebar';
import AIPanel from './components/AIPanel';
import { Project } from './types';

const App: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([
    { id: '1', name: 'NeuroFlow Core', lastUpdated: 'now' },
    { id: '2', name: 'EtherOS Prototype', lastUpdated: '1h ago' },
    { id: '3', name: 'Zenith Canvas', lastUpdated: 'yesterday' },
  ]);
  const [activeProjectId, setActiveProjectId] = useState<string>('1');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const activeProject = projects.find(p => p.id === activeProjectId) || projects[0];

  const handleSelectProject = (id: string) => {
    setActiveProjectId(id);
    setIsSidebarOpen(false); // Close sidebar on small mobile after selection
  };

  const handleAddProject = () => {
    const name = prompt('Enter new project name:');
    if (name) {
      const newProj: Project = {
        id: Math.random().toString(36).substr(2, 9),
        name: name,
        lastUpdated: 'just now'
      };
      setProjects([...projects, newProj]);
      setActiveProjectId(newProj.id);
      setIsSidebarOpen(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-white text-black font-['Segoe_UI'] relative">
      {/* Mobile Overlay - Only visible on screens smaller than md (768px) */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/20 z-40 md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      <Sidebar 
        projects={projects} 
        activeProjectId={activeProjectId} 
        onSelectProject={handleSelectProject} 
        onAddProject={handleAddProject}
        isOpen={isSidebarOpen}
      />
      
      <main className="flex-1 overflow-hidden relative flex flex-col w-full">
        <AIPanel 
          key={activeProjectId} 
          projectName={activeProject.name} 
          onMenuClick={() => setIsSidebarOpen(true)}
        />
      </main>
    </div>
  );
};

export default App;
