import fs from 'node:fs';
import { exec } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getInput(prompt) {
    return new Promise(resolve => {
        process.stdout.write(prompt);
        process.stdin.once('data', data => {
            resolve(data.toString().trim());
        });
    });
}

const defaultEnv = `SUBJECT_NAME=CS
MIN_COURSE_LEVEL=100
MAX_COURSE_LEVEL=900
TERM=auto`;

// WRITE ROUTINE
let settingsExists = fs.existsSync("SETTINGS.env");

if (process.argv.includes("--wizard")) {
    fs.unlinkSync("SETTINGS.env");
    settingsExists = false;
}

if (!settingsExists) {
    fs.writeFileSync("SETTINGS.env", defaultEnv);
    console.log("Created default SETTINGS.env file");

    console.log('Configuration creation wizard (CTRL+C to cancel):');

    const subject = await getInput("Enter subject name e.g CS,ECE (CS) ") || "CS";
    const minCourseLevel = await getInput("Min course level? (100) ") || "100";
    const maxCourseLevel = await getInput("Max course level? (900) ") || "900";
    const days = await getInput("Day that the course meets, or all? (all) ") || "all";
    const afterTime = await getInput("Only show courses that start after what 24-hour time? (7) ") || "7";


    const envContent = `SUBJECT_NAME=${subject}
MIN_COURSE_LEVEL=${minCourseLevel}
MAX_COURSE_LEVEL=${maxCourseLevel}
DAYS=${days}
AFTER_TIME=${afterTime}`;

    fs.writeFileSync("SETTINGS.env", envContent);
    console.log("Configuration saved to SETTINGS.env");
    settingsExists = true;
}

// READ ROUTINE
if (settingsExists) {
    const envConfig = fs.readFileSync("SETTINGS.env", "utf-8");
    const envLines = envConfig.split("\n");
    for (const line of envLines) {
        const [key, value] = line.split("=");
        if (key && value) {
            process.env[key] = value;
        }
    }
}

// SET VARS
const subject = process.env.SUBJECT_NAME || "CS";
const minCourseLevel = process.env.MIN_COURSE_LEVEL || "100";
const maxCourseLevel = process.env.MAX_COURSE_LEVEL || "900";

process.env.DAYS = process.env.DAYS || "all";
const days = process.env.DAYS === "all" ? "Monday,Tuesday,Wednesday,Thursday,Friday" : process.env.DAYS;
const afterTimeHour = process.env.AFTER_TIME || "7";

// COMPUTE DYNAMIC VARS
let term = "";
const year = new Date().getFullYear();
const month = new Date().getMonth() + 1; // getMonth() is zero-based

if (month >= 1 && month <= 5) {
    term = `Spring ${year}`;
} else if (month >= 6 && month <= 7) {
    throw new Error("Summer courses are not included in BoilerClasses API");
} else if (month >= 8 && month <= 12) {
    term = `Fall ${year}`;
}

let levels = "";
for (let i = Number(minCourseLevel); i <= Number(maxCourseLevel); i += 100) {
    levels += i + ",";
}
levels = levels.slice(0, -1); // Remove trailing comma

console.log(`Searching for ${subject} courses in ${term} with levels ${levels}`);

const params = new URLSearchParams({
    "$expand": "Classes($expand=Sections($expand=Meetings($expand=Instructors,Room($expand=Building))))",
    "$filter": `Subject/Abbreviation eq '${subject}'`,
});

const apiResponse = await (await fetch("https://api.purdue.io/odata/Courses?" + params.toString())).json();
console.log(`Found ${apiResponse.value.length} courses (including historical) in ${subject}`);

let courses = apiResponse.value;

// rebuild course list
let temp = [];
for (const course of courses) {
    const courseNumber = Number(course.Number) / 100;
    if (courseNumber < Number(minCourseLevel) || courseNumber > Number(maxCourseLevel)) {
        continue;
    }

    let found = false;
    for (const cls of course.Classes) {
        if (found) break;
        for (const section of cls.Sections) {
            const startDate = new Date(section.StartDate);
            const endDate = new Date(section.EndDate);
            const currentDate = new Date();

            if (currentDate > startDate && currentDate < endDate) {
                found = true;
                break;
            }
        }
    }

    if (!found) continue;
    temp.push(course);
}
courses = temp;

// Rebuild again (eliminate old entries)
temp = [];
for (const course of courses) {
    // Rebuild classes array with relevant classes only
    let tempClasses = [];
    for (const cls of course.Classes) {
        // Rebuild sections array with relevant sections only
        let tempSections = [];
        for (const sec of cls.Sections) {
            const startDate = new Date(sec.StartDate);
            const endDate = new Date(sec.EndDate);
            const currentDate = new Date();

            if (currentDate > startDate && currentDate < endDate && sec.Type === "Lecture") {
                let temp2 = [];
                // Rebuild meetings array with relevant meetings only
                for (const meet of sec.Meetings) {
                    const meetTypeLecture = meet.Type === "Lecture";

                    const meetingStartDate = new Date(meet.StartDate);
                    const meetingEndDate = new Date(meet.EndDate);
                    const meetingCurrentDate = new Date();
                    const current = meetingCurrentDate > meetingStartDate && meetingCurrentDate < meetingEndDate;

                    let meetsOnRequiredDay = false;
                    for (const day of (days ? days.split(",") : [])) {
                        if (meet.DaysOfWeek.includes(day.trim())) {
                            meetsOnRequiredDay = true;
                        }
                    }

                    const afterTime = afterTimeHour ? Number(afterTimeHour) : 0;
                    const meetsAfterRequiredTime = Number(meet.StartTime?.split(":")[0]) >= afterTime;

                    if (meetTypeLecture && current && meetsOnRequiredDay && meetsAfterRequiredTime) {
                        temp2.push(meet);
                    }
                }
                sec.Meetings = temp2;
                if (sec.Meetings.length > 0) {
                    tempSections.push(sec);
                }
            }
        }

        cls.Sections = tempSections;
        if (cls.Sections.length > 0) {
            tempClasses.push(cls);
        }
    }
    course.Classes = tempClasses;

    if (course.Classes.length > 0) {
        temp.push(course);
    }
}
courses = temp;

console.log(`After filtering, ${courses.length} courses remain.`);

const saveCourses = await getInput("Save courses to courses.json? y/n (y) ");
if (saveCourses.toLowerCase() === "y" || saveCourses.toLowerCase() === "yes" || saveCourses === "") {
    console.log("Saving to courses.json");
    fs.writeFileSync("courses.json", JSON.stringify(courses, null, 2));
}

console.log("Schedule:");
for (const course of courses) {
    for (const cls of course.Classes) {
        let i = 0;
        for (const sec of cls.Sections) {
            for (const meet of sec.Meetings) {
                i++;
                // console.log(meet)
                const instructors = meet.Instructors.map(i => i.Name).join(", ") || "TBA";
                const building = (meet.Room?.Building.ShortCode || "Unknown Building - ") + " " + meet.Room?.Number || "Unknown Room";
                const timesplit = meet.StartTime?.split(":");
                const time = timesplit[0] + ":" + timesplit[1];
                console.log(`${course.Number} - ${course.Title}
Section: ${i} | Type: ${sec.Type}
Meets on: ${meet.DaysOfWeek} from ${time} for ${meet.Duration?.replace("PT", "").toLowerCase()}
Location: ${building}
Instructors: ${instructors}
`);
            }
        }
    }
}

const openBrowser = await getInput("Open browser to view courses? y/n (y) ");
if (openBrowser.toLowerCase() === "y" || openBrowser.toLowerCase() === "yes" || openBrowser === "") {
    console.log("Starting local server...");
    
    // Create a simple HTTP server
    const server = http.createServer((req, res) => {
        let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
        
        // Security check to prevent directory traversal
        if (!filePath.startsWith(__dirname)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        const extname = path.extname(filePath);
        let contentType = 'text/html';
        
        switch (extname) {
            case '.js':
                contentType = 'application/javascript';
                break;
            case '.css':
                contentType = 'text/css';
                break;
            case '.json':
                contentType = 'application/json';
                break;
            case '.png':
                contentType = 'image/png';
                break;
            case '.jpg':
                contentType = 'image/jpg';
                break;
        }

        fs.readFile(filePath, (err, content) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    res.writeHead(404);
                    res.end('File not found');
                } else {
                    res.writeHead(500);
                    res.end('Server error');
                }
            } else {
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content);
            }
        });
    });

    const PORT = 3000;
    server.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}/`);
        console.log('Press Ctrl+C to stop the server');
        
        // Open browser after a short delay
        setTimeout(() => {
            const open = (process.platform === 'win32') ? 'start' : (process.platform === 'darwin') ? 'open' : 'xdg-open';
            exec(`${open} http://localhost:${PORT}`);
        }, 1000);
    });

    // Keep the process running
    process.on('SIGINT', () => {
        console.log('\nShutting down server...');
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    });
} else {
    process.exit(0);
}