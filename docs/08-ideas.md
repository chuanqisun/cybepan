1. Sense of agency: The current system gives user an indirect sense of control. Even with micro horizon attention, it feels like the user is a conductor, not a musician on the instrument.
   - How can we design a music playing experience that creates that sense of agency?
   - Research into music theory + cybernetics + HCI to understand where that sense of agency comes from.
   - We want direct manipulation but on the semantic level
   - The experience should give user joy, as if they can express their own emotions in realtime.
2. In-organtic tempo: the current setup locks the notes on a temporal grid and each note is precisely the same length. In real handpan performance, the artist can be very creative on the tempo.
   - Deep research into handpan master performance and understand the principles and human perception of tempo and rhythm.
   - Design systems that can produce the equivalent psychological experience
3. Our system has way too many knobs and controls.
   - Try to focus on what is essential. What is the most simple solution that can achieve the same effect?
   - Do NOT overwhelm user with many options. A handful of controls is enough. The rest can either be eliminated, programmatically deduced, or give it to gemini decisions API to handle.
4. The gemini decisions api is too bulky with occasional long latency
   - Innovate on notions and grammar. Turn music into a "language" that is concise and expressive
   - Let decision api work with concise notation to get lower latency
5. Think about steering as in https://github.com/chuanqisun/spaceship
   - Carefully study its UI/UX design patterns and philosophy
   - We need a representation of the score
   - Representing attention: micro, short, mid, long don't have to be discrete categories. If we draw connection lines, the line length automatically encodes horizone distance
   - We can have some visualization to suggest attention strength
   - What is the steering vectors user can play with? How to make that experience almost "electric" and "tactile"?
6. Instrument representation
   - The literal pan representation is optimized for physical acoustics and ergonomics
   - What is the digital representation that allows direct manipulation of the parameters we are exploring?
   - What visualization is as simple as possible but creates a very intuitive and expressive experience?
   - Can we combine the representation that produces the sound with the representation that allows direct manipulation?
