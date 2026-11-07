import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrologGoal, joinPath, parseCommands, prologArgs, splitArgs, stripPrologComment, toShellScript, validateScript } from '../lib/script.js';

// The breasoning instructions from the private repo, as written.
export const BREASONING = `# *** before final submission
# *** br with the first section before running, then run weekly 25 million

# DO NOT DO BR IF FOR THESIS YET

# grammar_logic_to_alg2.pl instructions

# breason out file.txt using t2b
# run gramm log
# run gl2a
# run t2b reading on gl2a output


# ** first section start

cd Dropbox/GitHub-private2/Text-to-Breasonings/

swipl --stack-limit=54G

['text_to_breasonings.pl'].
N=u,M=u,texttobr2(N,"file.txt",u,M,[auto,on]). % or off to enter breasonings (stop here before running rest).

% ******* STOP HERE, THEN DO BELOW

N=u,M=u,texttobr(N,"file.txt",u,M).

halt.


# Set Br to the desired limit of breasonings to breason out in the end/80.

cd ../Algorithm-Writer-with-Lists/

swipl --stack-limit=54G
['grammar_logic_to_alg.pl'].
['../Text-to-Breasonings/text_to_breasonings.pl'],
FileName2="./gl2a.txt",
FileName3="gl2a.txt",
protocol(FileName2).
notrace.
As is 4*50,Br is As*80,open_string_file_s("../Text-to-Breasonings/file.txt",Essay_0),grammar_logic_to_alg1(Essay_0,Br,GL_out1),term_to_atom(GL_out1,GL_out2),string_atom(GL_out,GL_out2),working_directory1(_,"../Text-to-Breasonings"),texttobr2(u,u,GL_out,u,[auto,on]),texttobr(u,u,GL_out,u).
noprotocol,
halt.
mv gl2a.txt ../Text-to-Breasonings/file.txt
logout
`;

test('splitArgs handles quotes and escapes', () => {
  assert.deepEqual(splitArgs(`a 'b c' "d \\"e\\"" f\\ g ''`), ['a', 'b c', 'd "e"', 'f g', '']);
});

test('joinPath normalises and never climbs above the root', () => {
  assert.equal(joinPath('a/b', '../c/'), 'a/c');
  assert.equal(joinPath('a', '../../x'), 'x');
  assert.equal(joinPath('a', '/x/y'), 'x/y');
});

test('stripPrologComment keeps % inside strings', () => {
  assert.equal(stripPrologComment('X = "50%". % note'), 'X = "50%".');
});

test('parses the breasoning instructions into the right steps', () => {
  const { steps, warnings } = parseCommands(BREASONING);
  assert.deepEqual(warnings, []);
  assert.deepEqual(steps.map((s) => s.type), ['prolog', 'pause', 'prolog', 'prolog', 'cmd']);

  const t2b = 'Dropbox/GitHub-private2/Text-to-Breasonings';
  const awl = 'Dropbox/GitHub-private2/Algorithm-Writer-with-Lists';
  assert.equal(steps[0].cwd, t2b);
  assert.equal(steps[0].stackLimit, '54G');
  assert.deepEqual(steps[0].goals, ["['text_to_breasonings.pl']", 'N=u,M=u,texttobr2(N,"file.txt",u,M,[auto,on])']);
  assert.match(steps[1].message, /STOP HERE/);
  // after the pause, the session restarts with the same files loaded
  assert.deepEqual(steps[2].goals, ["['text_to_breasonings.pl']", 'N=u,M=u,texttobr(N,"file.txt",u,M)']);
  assert.equal(steps[3].cwd, awl);
  assert.equal(steps[3].goals.length, 5);
  assert.equal(steps[3].goals[4], 'noprotocol');
  assert.match(steps[3].goals[1], /^\['\.\.\/Text-to-Breasonings\/text_to_breasonings\.pl'\], FileName2="\.\/gl2a\.txt", FileName3="gl2a\.txt", protocol\(FileName2\)$/);
  assert.deepEqual(steps[4], { type: 'cmd', cwd: awl, cmd: 'mv', args: ['gl2a.txt', '../Text-to-Breasonings/file.txt'] });
  assert.deepEqual(validateScript({ steps }), []);
});

test('warns about shell features', () => {
  const { warnings } = parseCommands('ls | wc -l');
  assert.equal(warnings.length, 1);
});

test('builds a goal that runs each query like the ?- prompt', () => {
  const goal = buildPrologGoal(['X = 1', 'Y = 2.']);
  assert.equal(
    goal,
    '(\\+ \\+ catch((X = 1), E, (print_message(error, E), fail)) -> true ; format(user_error, "Warning: query ~w failed~n", [1])), ' +
      '(\\+ \\+ catch((Y = 2), E, (print_message(error, E), fail)) -> true ; format(user_error, "Warning: query ~w failed~n", [2]))'
  );
  assert.deepEqual(prologArgs({ goals: ['true'], stackLimit: '2G' }).slice(0, 2), ['--stack-limit=2G', '-g']);
  assert.throws(() => prologArgs({ goals: ['true'], stackLimit: '2G; rm' }));
});

test('validation catches bad steps', () => {
  const errors = validateScript({
    steps: [{ type: 'cmd', cmd: '/bin/rm' }, { type: 'prolog', goals: [] }, { type: 'prolog', goals: ['x'], stdoutTo: '../x' }, { type: 'nope' }]
  });
  assert.equal(errors.length, 4);
});

test('exports a bash script', () => {
  const { steps } = parseCommands(BREASONING);
  const sh = toShellScript({ name: 'Breasoning', steps });
  assert.match(sh, /^#!\/bin\/bash/);
  assert.match(sh, /set -e/);
  assert.match(sh, /cd "\$ROOT"\/'Dropbox\/GitHub-private2\/Text-to-Breasonings'/);
  assert.match(sh, /read -r -p/);
  assert.match(sh, /'mv' 'gl2a.txt' '..\/Text-to-Breasonings\/file.txt'/);
});
