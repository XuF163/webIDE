
export enum ViewType {
  CHAT = 'CHAT',
  SETTINGS = 'SETTINGS'
}

export interface Project {
  id: string;
  name: string;
  lastUpdated: string;
}

export interface Message {
  role: 'user' | 'ai';
  content: string;
  timestamp: string;
}
