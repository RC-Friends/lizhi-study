import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App.jsx';
import AppBoundary from './AppBoundary.jsx';

createRoot(document.getElementById('root')).render(<React.StrictMode><AppBoundary><App /></AppBoundary></React.StrictMode>);
