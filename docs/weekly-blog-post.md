# I was asked to count stop codons in a phage. Naturally, I built an app.

*Draft for the weekly blog — edit the voice to taste. Tool: <https://mbaffour.github.io/stop-codon-finder/> · Code: <https://github.com/mbaffour/stop-codon-finder>*

---

My PI asked me a simple question this week: **how many stop codons are in bacteriophage N4?** We needed the number for a project. That's it. That's the whole ask.

There's a perfectly good answer to this that takes about five minutes. It's called **Galaxy** — log into the server, find a tool, point it at the genome, read off the number, get on with your life. I have used Galaxy for exactly this kind of thing many times. It works. It's the sensible choice.

I did not make the sensible choice.

Instead I thought: *what if I take Claude Code for a spin and just… build the thing myself?* Not a script buried in a folder I'll never find again — an actual little tool. Something that runs in the browser with no server to log into, no account, nothing uploaded anywhere. Something that lives on **my** GitHub, that I can open whenever I want, and that I can bend and customize however I like. A tool I own.

"Count the stop codons in N4" is, on paper, a tiny task. Reader, it did not stay tiny.

A little while later, "count the stop codons" had quietly become:

- a **six-frame scanner** (because of course you want both strands and all three frames);
- **gene-annotation mapping** — so it doesn't just count stops, it tells you which gene each one terminates, and flags the weird in-frame ones as possible readthrough or selenocysteine;
- the **full set of NCBI genetic-code tables**, because *Mycoplasma* reads TGA as tryptophan and ciliates do their own thing and I couldn't just pretend that wasn't true;
- exports to **CSV, Excel, GFF3, BED, FASTA** — the whole alphabet;
- **colourblind-safe charts**, a **genome map**, an ORF finder, and a **stop-to-stop / start-to-stop toggle** I definitely did not need but absolutely wanted;
- and — this is my favourite part — **N4 itself is now a one-click example inside the app**. The phage that started it all, bundled in forever.

Textbook scope creep. No regrets.

Here's the punchline, though. While I was down there in the weeds, wiring up genome maps and arguing with myself about coordinate conventions, **my PI just did it in Galaxy anyway.** Got the number. Moved on. The way a normal person would.

By then I was far, *far* too deep to stop. So here we are.

## Was it worth it?

If you're measuring "fastest path to the number my PI asked for," absolutely not — Galaxy won that race before I'd finished naming the repo.

But that's not really what I was optimizing for, and somewhere around the third feature I stopped pretending it was. What I actually got:

- **A tool I own.** It's static files on GitHub Pages. No server to go down, no login, no "the platform changed its UI again." I open a link and it works. If I want it to do something new, I change it.
- **Everything stays on my machine.** For unpublished sequences that matters — nothing is uploaded, it all runs locally in the browser. You can literally watch the Network tab do nothing.
- **I learned a pile.** Turns out "how many stop codons?" isn't even one number: it's **8,438** if you count every TAA/TAG/TGA across all six reading frames of N4, but only about **72** that actually terminate a gene. Building the thing forced me to be precise about which question I was answering — which is a better outcome than a single number I'd have half-trusted.
- **It was fun.** I'm allowed to say that. Not everything has to be the efficient path.

There's a bigger thing in here about tooling, too. We reach for big platforms by reflex — and often we should. But a surprising amount of day-to-day lab computation is small enough to just *own*: a page that does one thing, that you understand top to bottom, that lives somewhere you control. The barrier to building that used to be real. It's a lot lower now.

Anyway. If you need to count stop codons in a genome — or you just want a no-server tool you can fork and make your own — **it's all yours**: <https://mbaffour.github.io/stop-codon-finder/>.

Enjoy. And say hi to N4 for me; it's the third example in the list.
