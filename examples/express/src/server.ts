import { app } from './app';

app.listen(3000, (error) => {
  if (error !== undefined) throw error;
  console.log('Paid API listening on http://localhost:3000');
  console.log('In another terminal, run: pnpm agent');
});
