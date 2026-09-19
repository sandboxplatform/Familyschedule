/**
 * Sign in, or — on an install nobody has claimed yet — create the first
 * account. Which of the two this page offers is decided by the server, not by
 * the link that got here: /api/session says whether any account exists.
 */

const form = document.getElementById('form');
const email = document.getElementById('email');
const password = document.getElementById('password');
const confirm = document.getElementById('confirm');
const confirmField = document.getElementById('confirmField');
const passwordHint = document.getElementById('passwordHint');
const submit = document.getElementById('submit');
const error = document.getElementById('error');
const lede = document.getElementById('lede');
const swap = document.getElementById('swap');

let creating = false;
/* True while this is the very first account: the form cannot be switched away
   from signing up, because there is nothing yet to sign in to. */
let firstRun = false;

boot();

async function boot() {
  try {
    const state = await fetch('/api/session').then((r) => r.json());
    // Already signed in and not here to add somebody: nothing to do on a
    // sign-in page.
    if (state.authenticated && !new URLSearchParams(location.search).has('add')) {
      location.replace(safeNext());
      return;
    }
    firstRun = Boolean(state.setupRequired);
    const adding = new URLSearchParams(location.search).has('add');
    setMode(firstRun || adding);
  } catch {
    // Offline or still starting: leave the sign-in form as it stands, which is
    // the right guess for every install that has been used before.
    setMode(false);
  }
}

function setMode(signUp) {
  creating = signUp;

  lede.textContent = signUp
    ? firstRun
      ? 'Nobody has set this calendar up yet. The first account you create is the household account.'
      : 'Create another account for this household.'
    : firstRun
      ? 'There are no accounts on this calendar yet — create the first one to get in.'
      : 'Sign in to see the family calendar.';

  document.title = signUp ? 'Family Schedule — Create account' : 'Family Schedule — Sign in';
  submit.textContent = signUp ? 'Create account' : 'Sign in';
  confirmField.hidden = !signUp;
  passwordHint.hidden = !signUp;
  password.setAttribute('autocomplete', signUp ? 'new-password' : 'current-password');
  confirm.required = signUp;

  // The way across is always offered, including on an install that reports no
  // accounts. Somebody who is sure they already have one is better served by
  // being able to try it — and told plainly that nothing is stored here — than
  // by a form with no way out of it.
  swap.hidden = false;
  swap.replaceChildren(
    document.createTextNode(
      signUp ? 'Already have an account? ' : firstRun ? 'Need to set one up? ' : 'Adding someone new? ',
    ),
    link(signUp ? 'Sign in' : 'Create an account', () => setMode(!signUp)),
  );
  hideError();
}

function link(text, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

/**
 * Where to land after signing in: back to whatever was asked for, or — when
 * nothing was — the screen that suits the thing being held. A phone gets the
 * editor, a monitor or a TV gets the display.
 */
function safeNext() {
  const requested = new URLSearchParams(location.search).get('next');
  if (!requested || !requested.startsWith('/') || requested.startsWith('//')) {
    return defaultDestination();
  }
  return requested;
}

/**
 * A phone is a coarse pointer on a screen narrow in its shortest dimension —
 * shortest, so that turning one sideways does not make it a television, which
 * is a coarse pointer too because a remote is not a mouse. Everything wider
 * than a phone, tablets included, gets the display: it is the view the app is
 * named for, and it carries a button to the editor for anyone who wanted that
 * instead.
 */
export function defaultDestination(view = window) {
  const coarse = view.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  const shortestEdge = Math.min(view.innerWidth || 0, view.innerHeight || 0);
  return coarse && shortestEdge < 500 ? '/edit' : '/';
}

function showError(message, focus) {
  error.textContent = message;
  error.classList.add('is-shown');
  focus?.select?.();
}

function hideError() {
  error.classList.remove('is-shown');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideError();

  if (creating && password.value !== confirm.value) {
    showError('Those passwords do not match', confirm);
    return;
  }

  submit.disabled = true;
  try {
    const response = await fetch(creating ? '/api/account' : '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value, password: password.value }),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        !creating && firstRun
          ? 'This calendar has no accounts stored — create one to get in.'
          : payload.error || 'That did not work — try again';
      showError(message, password);
      return;
    }

    // Creating the first account signs you in; adding a second from inside
    // does not, so the person already signed in stays that way.
    if (payload.signedIn) {
      // A brand new household has nothing to look at yet — send them to set it
      // up rather than to an empty calendar.
      location.replace('/edit?setup=1');
      return;
    }
    if (!creating) {
      location.replace(safeNext());
      return;
    }
    setMode(false);
    showError(`${payload.user.email} can now sign in.`);
    error.classList.add('is-shown');
  } catch {
    showError('Could not reach the calendar — is it still running?');
  } finally {
    submit.disabled = false;
  }
});
