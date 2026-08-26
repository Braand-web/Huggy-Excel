import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const app = { innerHTML: '', addEventListener() {} };
let capturedBlob = null;
let capturedDownload = '';
const context = vm.createContext({
  console,
  document: {
    querySelector: () => app,
    createElement: () => ({
      href: '',
      download: '',
      click() { capturedDownload = this.download; },
    }),
  },
  window: {
    HUGGY_AUTH_CONFIG: {},
    location: { hash: '', search: '', pathname: '/', origin: 'https://huggy.fun' },
  },
  history: { replaceState() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {} },
  URL: {
    createObjectURL(blob) { capturedBlob = blob; return 'blob:huggy-test'; },
    revokeObjectURL() {},
  },
  URLSearchParams,
  Blob,
  TextDecoder,
  crypto,
  fetch,
  setTimeout,
  clearTimeout,
});

vm.runInContext(source, context);
vm.runInContext(`
  state.files = [{
    id: 'custom-result',
    name: 'budget-ecole.xlsx',
    prompt: 'Crée un budget pour une école',
    version: 1,
    workbook: {
      title: 'Budget école',
      summary: 'Budget personnalisé pour une école.',
      notes: ['Montants à adapter.'],
      sheets: [
        { name: 'Revenus', rows: [['Source', 'Montant'], ['Scolarité', 2500000]] },
        { name: 'Dépenses', rows: [['Poste', 'Montant'], ['Fournitures', 350000]] },
        { name: 'Synthèse', rows: [['Indicateur', 'Valeur'], ['Solde', 2150000]] },
      ],
    },
  }];
  state.current = 'custom-result';
  state.sheet = 'sheet-0';
`, context);

const preview = vm.runInContext('previewModal()', context);
assert.match(preview, /Revenus/);
assert.match(preview, /Dépenses/);
assert.match(preview, /Synthèse/);
assert.match(preview, /Scolarité/);
assert.doesNotMatch(preview, /Casque audio/);

vm.runInContext('downloadWorkbook()', context);
assert.equal(capturedDownload, 'budget-ecole.xls');
assert.ok(capturedBlob);
const workbookXml = await capturedBlob.text();
assert.match(workbookXml, /Worksheet ss:Name="Revenus"/);
assert.match(workbookXml, /Worksheet ss:Name="Dépenses"/);
assert.match(workbookXml, /Worksheet ss:Name="Synthèse"/);
assert.match(workbookXml, /Scolarité/);
assert.match(workbookXml, /Fournitures/);

console.log('Workbook UI test passed: custom sheets are previewed and exported.');
