const moduleUrl = new URL('./build/bootstrap/loadModules.js', import.meta.url).href;
import(moduleUrl).then(async ({ loadAppModules }) => {
  const result = await loadAppModules('all');
  console.log('controllers count', result.controllers.length);
  console.log('controller names', result.controllers.map(c => c.name));
  console.log('validators count', result.validators.length);
  console.log('validator names', result.validators.map(v => v.name));
}).catch(err => {
  console.error(err);
  process.exit(1);
});
