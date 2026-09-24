// Words for the blocked screen (carried over from FocusGuard 3.x).

export const GITA = [
  ["कर्मण्येवाधिकारस्ते मा फलेषु कदाचन।", "Tumhara adhikar karm par hai, result par nahi. Abhi effort par focus karo."],
  ["योगस्थः कुरु कर्माणि सङ्गं त्यक्त्वा धनञ्जय।", "Balance ke saath apna kaam karo, result ki anxiety ko side rakho."],
  ["न हि ज्ञानेन सदृशं पवित्रमिह विद्यते।", "Is duniya mein knowledge se zyada pavitra kuch nahi. Seekhna continue rakho."],
  ["उद्धरेदात्मनात्मानं नात्मानमवसादयेत्।", "Khud ko khud hi upar uthao; apni himmat ko neeche mat girne do."],
  ["आत्मैव ह्यात्मनो बन्धुरात्मैव रिपुरात्मनः।", "Tum khud apne best friend bhi ho aur worst enemy bhi. Choice tumhari hai."],
  ["तस्मादसक्तः सततं कार्यं कर्म समाचर।", "Attachment chhodo, consistency pakdo. Roz ka kaam hi progress banata hai."],
  ["श्रद्धावान् लभते ज्ञानं तत्परः संयतेन्द्रियः।", "Faith, focus aur self-control se knowledge milti hai."],
  ["संशयात्मा विनश्यति।", "Constant doubt action ko destroy karta hai. Decide karo aur start karo."],
  ["न हि कल्याणकृत्कश्चिद् दुर्गतिं तात गच्छति।", "Sincere effort kabhi waste nahi hota; good work ka result zaroor aata hai."],
  ["मात्रास्पर्शास्तु कौन्तेय शीतोष्णसुखदुःखदाः।", "Comfort aur discomfort temporary hain. Goal ke liye dono tolerate karo."],
  ["समत्वं योग उच्यते।", "Difficult day mein balance maintain karna hi real yoga hai."],
  ["योगः कर्मसु कौशलम्।", "Apne kaam ko skill aur sincerity ke saath karna hi yoga hai."]
];

export const MOTIVATION = [
  "Aaj ka focus kal ka confidence banega. Ab tab band karo.",
  "Offer letter imagination se nahi, boring daily practice se aata hai.",
  "Distraction ko reward samajhna band karo. Reward tab milega jab target complete hoga.",
  "Ek video tumhari life nahi badlega. Ek consistent habit badal sakti hai.",
  "Aaj ka small sacrifice, interview ke din bada advantage ban sakta hai.",
  "Tum capable ho, lekin capability bina discipline ke sirf potential reh jaati hai.",
  "Apne future self ko disappoint mat karo. Aaj ka next problem solve karo.",
  "Tumhe motivation nahi, ek honest next step chahiye. Start now.",
  "Aaj sirf 25 minutes do. Kal ka confidence aaj ke decision se banega."
];

const ROASTS = {
  video: [
    'Interviewer ye nahi puchega ki "{title}" ka ending kya tha. DSA karo.',
    "YouTube pe ye khula hai aur Striver sheet ka next topic abhi tak pending hai.",
    "Ye video offer letter nahi dilayega. LeetCode ka daily problem dilayega."
  ],
  social: [
    "{site} pe scroll karke resume nahi banta. IDE kholo.",
    "Feed infinite hai, placement season finite. Priorities samjho.",
    "{site} ki timeline se tera future nahi banega. LeetCode ki timeline se banega."
  ],
  generic: [
    "Ek aur distraction, ek aur wasted hour. Pattern samajh aa raha hai?",
    "{site} se tera CTC decide nahi hoga, tera DSA skill decide karega.",
    "Tera competitor aaj bhi practice kar raha hai. Gap khud nahi bharega.",
    "Placement season excuses ko reward nahi karta. Ya skill build hogi, ya regret."
  ]
};

const pick = list => list[Math.floor(Math.random() * list.length)];

export function roastFor({ site, title, isVideo, isSocial }) {
  const pool = isVideo ? ROASTS.video : isSocial ? ROASTS.social : ROASTS.generic;
  const shortTitle = title && title.length > 50 ? `${title.slice(0, 47)}…` : title || "ye content";
  return pick(pool).replace("{title}", shortTitle).replace("{site}", site || "Is site");
}

export function randomWisdom() {
  return { shlok: pick(GITA), motivation: pick(MOTIVATION) };
}
