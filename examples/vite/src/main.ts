import { SDK_VERSION } from '@web-report-sdk/browser';

const app = document.querySelector('#app');
if (app) {
  app.textContent = `web-report-sdk ${SDK_VERSION}`;
}
