import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { AlertCircle } from 'lucide-react';
import { Button, Field, Input } from '../ui/index.tsx';
import { Logo } from './components/index.tsx';
import { useAuth } from './auth.tsx';
import { errorMessage } from './lib.ts';
import { trialSummary, usePlans } from './billing/api.ts';

export function LoginPage() {
  return <AuthPage mode="login" />;
}
export function SignupPage() {
  return <AuthPage mode="signup" />;
}

function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const { user, login, signup } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  // ?plan=<id> (from the pricing section): after signing up, go straight on to Stripe Checkout.
  const planId = params.get('plan');
  const next = params.get('next') || (planId ? `/billing?start=${encodeURIComponent(planId)}` : '/studies');
  const plans = usePlans();
  const plan = planId && plans?.enabled ? plans.plans.find((p) => p.id === planId) : undefined;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (user) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    if (mode === 'signup' && password.length < 8) return setErr('Password must be at least 8 characters.');
    setBusy(true);
    try {
      if (mode === 'login') await login(email.trim(), password);
      else await signup(name.trim() || email.split('@')[0], email.trim(), password);
      nav(next, { replace: true });
    } catch (e) {
      const m = errorMessage(e);
      setErr(mode === 'login' && /401|invalid|credentials/i.test(m) ? 'That email and password do not match.' : m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <div className="px-6 py-4">
        <Link to="/" className="inline-block"><Logo /></Link>
      </div>
      <div className="flex flex-1 items-start justify-center px-6 pb-24 pt-[8vh]">
        <div className="w-full max-w-[400px]">
          <h1 className="text-center text-[34px] font-bold leading-tight tracking-[-0.022em]">{mode === 'login' ? 'Sign in' : 'Create your account'}</h1>
          <p className="mt-2 text-center text-[15px] text-secondary">
            {mode === 'login' ? 'Welcome back to ThinkAloud.' : 'Run your first moderated study in minutes.'}
          </p>
          {plan && (
            <p className="mt-3 text-center text-[13px] text-secondary" data-testid="signup-plan">
              Next, you’ll add a card for the {plan.name} plan. {trialSummary(plan)}
            </p>
          )}
          <form onSubmit={submit} className="mt-8 rounded-[22px] bg-surface p-6 shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_30px_rgba(0,0,0,.05)] ring-1 ring-black/[0.04]">
            <div className="space-y-4">
              {mode === 'signup' && (
                <Field label="Name">
                  <Input name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" autoFocus />
                </Field>
              )}
              <Field label="Email">
                <Input name="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@lab.org" autoFocus={mode === 'login'} />
              </Field>
              <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters.' : undefined}>
                <Input name="password" type="password" required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              {err && (
                <p className="flex items-start gap-2 text-[13px] text-[#d70015]">
                  <AlertCircle className="mt-px size-4 shrink-0" /> {err}
                </p>
              )}
            </div>
            <Button type="submit" loading={busy} className="mt-6 w-full" size="lg">
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </form>
          <p className="mt-6 text-center text-[14px] text-secondary">
            {mode === 'login' ? (
              <>New to ThinkAloud? <Link to={`/signup${params.toString() ? `?${params}` : ''}`} className="text-brand-500 hover:underline">Create an account</Link></>
            ) : (
              <>Already have an account? <Link to={`/login${params.toString() ? `?${params}` : ''}`} className="text-brand-500 hover:underline">Sign in</Link></>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
