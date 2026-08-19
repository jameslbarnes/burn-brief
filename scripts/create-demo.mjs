// Creates a completely fictional local data set for screenshots and UI work.
// Refuses to run unless BURN_BRIEF_HOME names an obviously temporary demo dir.

import { basename } from "node:path";
import { Store } from "../dist/store.js";

const target = process.env.BURN_BRIEF_HOME;
if (!target || !basename(target).startsWith("burn-brief-demo-")) {
  throw new Error("Set BURN_BRIEF_HOME to a temporary directory named burn-brief-demo-*");
}

const day = new Date().toLocaleDateString("en-CA");
const store = new Store(target);
try {
  if (store.messageCount().total || store.latestDigest()) {
    throw new Error("Demo directory is not empty; choose a fresh temporary directory");
  }
  store.setIdentity({ ownJid: "15555550123@s.whatsapp.net", aliases: ["Alex", "Lex"] });
  store.setProfile("I'm Alex. I'm building a small light installation, helping my camp with power and arriving for build week.");
  store.setFocus({
    text: "Preparing for and attending Burning Man: camp logistics, build, rides, deadlines and people waiting on me.",
    anchorDate: "2026-08-30",
    anchorLabel: "gate",
    keywords: ["burn", "playa", "brc", "camp", "build", "ride", "ticket", "water", "power"],
  });

  const actions = [
    ["Confirm Thursday's 9 a.m. water call", "The team is locking the time today and still needs your answer."],
    ["Post your Saturday ride request", "Arrival plans are converging now, while drivers are still reading the thread."],
    ["Send the below-face ticket lead to camp", "A buyer surfaced this morning and the offer is likely to move quickly."],
    ["Run a full test of the LED panel rig", "Housing is confirmed; power draw is the last unknown before packing."],
    ["Pack a bowl, spoon and spare connectors", "Camp provides dinner, not dishware, and the art build needs its own spares."],
  ];
  const followUps = actions.map(([title, why]) => {
    const loopId = store.insertLoop(title, why, day);
    return { title, why, itemIds: [], loopId, firstDay: day };
  });
  const completed = store.insertLoop("Submit camp arrival dates", "Meal planning needs a head count.", day);
  store.closeLoop(completed, "done", "Submitted in the camp form");

  store.saveDigest(day, JSON.stringify({
    day,
    headline: "Water call firms up as the final electrical shift remains open",
    narrative: [
      "The water team is converging on Thursday at 9 a.m. Pacific, and your answer is still missing. One half-day electrical shift also remains open; training is included, and one reply can settle both decisions.",
      "Camp logistics are nearly buttoned up. The trailer tow is covered, water pickup is assigned and meals run daily through departure. Pack your own bowl and spoon. Arrivals cluster late Wednesday and Thursday afternoon, so this is the moment to post your Saturday ride request.",
      "A below-face ticket pair is still available, and a buyer surfaced in the ticket thread this morning. Forwarding the lead to camp is a small action with a short shelf life. Your light installation has a home; a full power test is the only meaningful build risk left.",
      "In the quieter threads, an old friend wants to reconnect after the burn and the camp photo crew is collecting one last video from you. Neither is urgent, but both are worth keeping warm.",
      "Goal — Find a Saturday ride into Black Rock City: No progress surfaced in today's messages.",
    ].join("\n\n"),
    goalUpdates: [{
      goalId: 1,
      description: "Find a Saturday ride into Black Rock City",
      status: "no_progress",
      text: "No progress surfaced in today's messages.",
    }],
    followUps,
    resolvedLoops: [],
    principle: {
      name: "Radical Self-reliance",
      line: "Bring what you need, and draw on your own inner resources.",
      reflection: "The city works because everyone arrives ready to care for themselves and therefore free to help someone else. Every cable you test and every bottle you label this week turns uncertainty into generosity on playa.",
      tip: "Run the complete light rig for two hours before packing it. Record the power draw and put every adapter it used into the same labeled pouch.",
    },
    stats: { newItems: 17, messagesScanned24h: 186, liveCutoffs: 4, openAsks: 1 },
  }));
} finally {
  store.close();
}

console.log(`Created fictional burn/brief demo data in ${target}`);
