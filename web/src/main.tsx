import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from '@ui5/webcomponents-react';
import { setLanguage } from '@ui5/webcomponents-base/dist/config/Language.js';
import { setDefaultFontLoading } from '@ui5/webcomponents-base/dist/config/Fonts.js';
import '@ui5/webcomponents-react/dist/Assets.js';
import '@ui5/webcomponents-icons/dist/AllIcons.js';
import '@ui5/webcomponents-fiori/dist/illustrations/AllIllustrations.js';
import { App } from './App';
import { autofillSperren } from './autofill';
import { erscheinungInitialisieren } from './theme';
import './styles.css';

setLanguage('de');
// Schrift "72" kommt lokal aus /fonts (siehe scripts/fonts.mjs), nicht vom CDN
setDefaultFontLoading(false);
erscheinungInitialisieren();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);

autofillSperren();
