import {registerHooks} from 'node:module';
// Production uses Vite/TypeScript extensionless imports. Native Node tests need
// the same resolution when formerly standalone helpers gain scoped storage.
registerHooks({resolve(specifier,context,next){
  return next(/^\.\.?\//u.test(specifier)&&!/\.[cm]?[jt]sx?$/u.test(specifier)&&context.parentURL?.endsWith('.ts')?specifier+'.ts':specifier,context);
}});
