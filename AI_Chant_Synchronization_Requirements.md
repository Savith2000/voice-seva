# AI Chant Synchronization Platform — Project Requirements

*From: surendra <suree.lovesai@gmail.com>*
*Date: Tue, Jul 21, 2026*

> Below are the overall requirements. This is for reference. We can just concentrate on main functionalities for now.

## 1. Important Requirements

### 1.1 Live Chant Recognition

The application should listen to live chanting through the microphone and identify:

- The chant being recited
- The current Anuvaka, verse, or line
- Repeated, skipped, or restarted portions
- Sudden movement to a different Anuvaka or chant

The system should support both individual and group chanting.

### 1.2 Automatic Script Scrolling

Once the current line is identified, the application should:

- Highlight the line being chanted
- Automatically scroll as chanting progresses
- Keep the current line visible near the center of the screen
- Stop scrolling when chanting pauses
- Resume when chanting continues

### 1.3 Sequential and Non-Sequential Detection

The system should first expect the next sequential line for faster recognition.

When the expected line does not match, it should quickly search the complete script and locate:

- A different Anuvaka
- A previous section
- A skipped section
- A repeated mantra
- A different chant

The screen should jump only after the new position is confirmed.

### 1.4 Script, Transliteration, and Meaning

The display should support:

- Original Sanskrit or regional-language text
- English transliteration
- Line-by-line meaning
- Word-by-word meaning where available

Users should be able to choose which information is displayed.

### 1.5 Multiple Chants and Stotrams

The platform should not be restricted to Rudram. It should support:

- Namakam and Chamakam
- Vedic Suktams
- Stotrams
- Sahasranamams
- Slokas
- Bhagavad Gita chanting
- Other spiritual and devotional texts

The same recognition and scrolling engine should work for all supported texts.

### 1.6 JSON Builder

The administrator should be able to upload or paste a chanting script.

The system should automatically create structured JSON containing:

- Chant name
- Sections or Anuvakas
- Verses and lines
- Sequence numbers
- Original script
- Transliteration
- Meaning
- Normalized phonetic text used for recognition

The administrator should be able to review, correct, and publish the generated JSON.

### 1.7 Confidence and Error Handling

The system should assign a confidence level to each detected line.

- **High confidence**: highlight and scroll automatically
- **Medium confidence**: verify using additional audio before jumping
- **Low confidence**: keep the screen stable and show "Locating chanting position."

Users should also be able to manually select the correct line when needed.

### 1.8 Audio and Matching Engine

The solution should not depend only on normal speech-to-text. It should combine:

- Audio recognition
- Phonetic matching
- Partial phrase matching
- Sanskrit pronunciation variations
- Current and previous line context
- Expected next-line prediction
- Global script search when synchronization is lost

The system mainly needs to identify the matching line from a known script rather than generate a perfect transcription.

### 1.9 Main User Interface

The chanting screen should contain:

- Chant and Anuvaka name
- Current highlighted line
- Transliteration and meaning
- Microphone status
- Auto-scroll toggle
- Pause and resume controls
- Manual search and navigation
- Font-size and full-screen options

### 1.10 Performance Expectations

- Sequential lines should normally be detected within about one second
- A sudden jump to another section should ideally be detected within two to three seconds
- Scrolling should be smooth and should not jump because of uncertain recognition
- The application should support long chanting sessions

## 2. Good-to-Have Requirements

### 2.1 Audio and Video Upload

Allow users to upload recorded audio or video and generate synchronized chanting text.

### 2.2 Automatic Chant Identification

Allow the system to identify the chant automatically without requiring the user to select it first.

### 2.3 Learning and Practice Mode

Provide:

- Reference pronunciation audio
- Repeat-one-line practice
- Gentle identification of missed or uncertain words
- Progress tracking

### 2.4 Presentation Mode

Display large synchronized text on:

- Projectors
- Televisions
- Temple screens
- Secondary devices

A leader should be able to control the presentation from another device.

### 2.5 Custom Chanting Sequence

Allow users to create a sequence containing multiple chants, such as:

- Ganapati prayer
- Namakam
- Chamakam
- Mantra Pushpam
- Arathi

### 2.6 Multiple Languages

Allow meanings to be displayed in English, Hindi, Telugu, Tamil, Kannada, Malayalam, and other languages.

### 2.7 Session Recording and Replay

With user permission, record chanting sessions and replay them later with synchronized line highlighting.

### 2.8 Offline Mode

Allow downloaded scripts and limited recognition to work when internet connectivity is unavailable.

### 2.9 Bookmarks and Notes

Allow users to bookmark verses, save difficult lines, and add personal notes.

### 2.10 Analytics and Improvement

Track:

- Recognition accuracy
- Lines frequently detected incorrectly
- Time taken to recover synchronization
- Manual corrections made by users

This information can help improve the recognition model.

## Core Project Goal

> The application should listen to chanting, identify the correct line from a structured chant library, automatically scroll and highlight that line, and immediately recover when the chanting moves to a different section.

## Suggested Initial Scope

The first release should focus on:

- Sri Rudram Namakam
- Live microphone recognition
- Sequential line tracking
- Sudden Anuvaka jump detection
- Automatic highlighting and scrolling
- Script, transliteration, and meaning display
- A manually prepared JSON structure

After this works accurately, the JSON Builder, Chamakam, and other Stotrams can be added.

---

*Sairam*
