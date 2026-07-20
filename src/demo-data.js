const now = new Date();
const day = 24 * 60 * 60 * 1000;
const iso = (offset, hour, minute = 0) => {
  const date = new Date(now.getTime() + offset * day);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};

export function createDemoArchive() {
  const chats = [
    {
      id: 'demo-family',
      name: 'Family',
      type: 'private_group',
      messages: [
        { id: 'f1', date: iso(-9, 10, 12), senderId: 'user_maya', senderName: 'Maya', text: 'I found the photos from our trip! ✨', type: 'message', media: [{ type: 'photo', path: null, demoGradient: 'sunset', width: 1080, height: 720 }] },
        { id: 'f2', date: iso(-9, 10, 15), senderId: 'owner', senderName: 'You', text: 'That view was unreal. Send the one from the lake too?', type: 'message', isOutgoing: true, replyToId: 'f1' },
        { id: 'f3', date: iso(-9, 10, 16), senderId: 'user_maya', senderName: 'Maya', text: 'Already on it 😄', type: 'message', reactions: [{ emoji: '❤', count: 2 }, { emoji: '🔥', count: 1 }] },
        { id: 'f4', date: iso(-3, 18, 30), senderId: 'user_dad', senderName: 'Dad', text: 'Sunday lunch at 13:00? I’ll make the legendary potatoes.', type: 'message' },
        { id: 'f5', date: iso(-3, 18, 32), senderId: 'owner', senderName: 'You', text: 'Count me in. I’ll bring dessert.', type: 'message', isOutgoing: true },
        { id: 'f6', date: iso(-3, 18, 33), senderId: 'user_maya', senderName: 'Maya', text: 'Perfect. See everyone Sunday!', type: 'message' },
      ],
    },
    {
      id: 'demo-alex',
      name: 'Alex Morgan',
      type: 'personal_chat',
      messages: [
        { id: 'a1', date: iso(-30, 9, 0), senderId: 'alex', senderName: 'Alex Morgan', text: 'Here is the design brief: https://example.com/brief', type: 'message', media: [{ type: 'link', url: 'https://example.com/brief', title: 'Project brief', description: 'Goals, decisions, and next steps' }] },
        { id: 'a2', date: iso(-30, 9, 4), senderId: 'owner', senderName: 'You', text: 'Got it — I’ll leave notes this afternoon.', type: 'message', isOutgoing: true },
        { id: 'a3', date: iso(-2, 14, 20), senderId: 'alex', senderName: 'Alex Morgan', text: 'The final files are ready.', type: 'message', media: [{ type: 'file', path: null, fileName: 'project-handoff.pdf', mimeType: 'application/pdf', size: 2840000 }] },
        { id: 'a4', date: iso(-2, 14, 25), senderId: 'owner', senderName: 'You', text: 'Wonderful, thank you! I’ll review them tomorrow morning.', type: 'message', isOutgoing: true, reactions: [{ emoji: '👍', count: 1 }] },
      ],
    },
    {
      id: 'demo-book-club',
      name: 'Weekend Book Club',
      type: 'private_group',
      messages: [
        { id: 'b1', date: iso(-14, 20), senderId: 'nora', senderName: 'Nora', text: 'Next pick: The Left Hand of Darkness?', type: 'message', poll: { question: 'Choose our next book', options: [{ text: 'The Left Hand of Darkness', votes: 6, chosen: true }, { text: 'Piranesi', votes: 4 }, { text: 'Sea of Tranquility', votes: 3 }], totalVoters: 13 } },
        { id: 'b2', date: iso(-14, 20, 8), senderId: 'sam', senderName: 'Sam', text: 'Strong yes from me.', type: 'message' },
        { id: 'b3', date: iso(-1, 17, 40), senderId: 'nora', senderName: 'Nora', text: 'Reminder: Saturday at Common Ground, 16:00.', type: 'message', location: { latitude: 48.1486, longitude: 17.1077, placeName: 'Common Ground' } },
      ],
    },
    {
      id: 'demo-saved',
      name: 'Saved Messages',
      type: 'saved_messages',
      messages: [
        { id: 's1', date: iso(-20, 8, 30), senderId: 'owner', senderName: 'You', text: 'Packing list\n• passport\n• charger\n• headphones\n• book', type: 'message', isOutgoing: true },
        { id: 's2', date: iso(-5, 12), senderId: 'owner', senderName: 'You', text: 'A good idea is a question that keeps unfolding.', type: 'message', isOutgoing: true, forwardedFrom: 'Notes to self' },
        { id: 's3', date: iso(-1, 9, 12), senderId: 'owner', senderName: 'You', text: '', type: 'message', media: [{ type: 'voice', path: null, duration: 37, fileName: 'Voice message' }] },
      ],
    },
  ];

  return {
    format: 'demo',
    title: 'My Telegram archive',
    sourceName: 'Demo archive',
    owner: { id: 'owner', name: 'You' },
    chats,
    warnings: [],
    stats: {
      chats: chats.length,
      messages: chats.reduce((total, chat) => total + chat.messages.length, 0),
    },
  };
}
