async function run() {
  const create = await fetch('http://localhost:8080/api/livequizzes/rooms/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Flow Room', teacherId: 'teacher123' }),
  });

  const room = await create.json();
  console.log('CREATE', create.status, room);
  if (!room.roomCode) {
    console.error('Room creation failed');
    process.exit(1);
  }

  const gen = await fetch(`http://localhost:8080/api/livequizzes/rooms/${room.roomCode}/generate-questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transcript: 'This is a short test transcript for generating questions from pasted content.',
      questionSpec: '{"MCQ":2}',
      model: 'gpt-3.5-turbo',
      questionCount: 2,
    }),
  });
  const result = await gen.json();
  console.log('GEN', gen.status, result);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
