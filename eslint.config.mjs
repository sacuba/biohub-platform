import tseslint from 'typescript-eslint';
export default tseslint.config({ignores:['.next*/**','node_modules/**','next-env.d.ts','test-results/**','src/generated/**']},...tseslint.configs.recommended,{rules:{'@typescript-eslint/no-explicit-any':'off','@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}]}});
