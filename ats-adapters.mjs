// ats-adapters.mjs
// ATS Platform Detection & Field Mapping for Auto-Apply
//
// This module is READ by Claude to know what form fields to expect
// and what selectors to use when driving Playwright during auto-apply.
// It exports platform metadata, detection logic, and profile-to-field mapping.

export const platforms = {
  greenhouse: {
    name: 'Greenhouse',
    detect: [/job-boards\.greenhouse\.io/, /boards\.greenhouse\.io/],
    applyUrl: (url) => (url.includes('#app') ? url : url + '#app'),
    standardFields: {
      firstName: { selector: '#first_name', type: 'text' },
      lastName: { selector: '#last_name', type: 'text' },
      email: { selector: '#email', type: 'text' },
      phone: { selector: '#phone', type: 'text' },
      resume: {
        selector: 'input[type="file"][name*="resume"], input[type="file"][id*="resume"]',
        type: 'file',
      },
      coverLetter: {
        selector:
          'input[type="file"][name*="cover_letter"], input[type="file"][id*="cover_letter"]',
        type: 'file',
      },
      linkedin: {
        selector:
          'input[name*="linkedin"], input[autocomplete="url"][id*="linkedin"], input[id*="job_application_answers_attributes"][id*="linkedin"]',
        type: 'text',
      },
      website: {
        selector:
          'input[name*="website"], input[name*="portfolio"], input[id*="website"]',
        type: 'text',
      },
      location: {
        selector: 'input[name*="location"], input[id*="location"]',
        type: 'text',
      },
    },
    customQuestionSelectors: {
      textInput:
        '.field input[type="text"]:not(#first_name):not(#last_name):not(#email):not(#phone)',
      textArea: '.field textarea',
      select: '.field select',
      checkbox: '.field input[type="checkbox"]',
      radio: '.field input[type="radio"]',
    },
    submitSelector: '#submit_app, input[type="submit"], button[type="submit"]',
    formContainerSelector: '#application, #app_body, .application-form',
    successIndicators: [
      'Thank you for applying',
      'Application submitted',
      'has been received',
      'successfully submitted',
    ],
    notes:
      'Most standardized ATS. Apply button usually at #app anchor or inline form. Custom questions use data-question attributes. Resume upload triggers a hidden iframe.',
  },

  lever: {
    name: 'Lever',
    detect: [/jobs\.lever\.co/],
    applyUrl: (url) => {
      // Lever apply page is /apply at the end of the job URL
      if (url.includes('/apply')) return url;
      return url.replace(/\/?$/, '/apply');
    },
    standardFields: {
      fullName: {
        selector: 'input[name="name"], input[placeholder*="Full name"]',
        type: 'text',
        note: 'Lever uses a single full name field, not first/last',
      },
      email: {
        selector: 'input[name="email"], input[type="email"]',
        type: 'text',
      },
      phone: {
        selector: 'input[name="phone"], input[type="tel"]',
        type: 'text',
      },
      resume: {
        selector: 'input[type="file"][name="resume"], .resume-upload input[type="file"]',
        type: 'file',
      },
      coverLetter: {
        selector: 'textarea[name="comments"]',
        type: 'textarea',
        note: 'Lever uses a textarea for cover letter / additional info, not a file upload',
      },
      linkedin: {
        selector: 'input[name="urls[LinkedIn]"], input[name*="LinkedIn"]',
        type: 'text',
      },
      website: {
        selector:
          'input[name="urls[Portfolio]"], input[name="urls[Other]"], input[name*="Portfolio"]',
        type: 'text',
      },
      github: {
        selector: 'input[name="urls[GitHub]"], input[name*="GitHub"]',
        type: 'text',
      },
      twitter: {
        selector: 'input[name="urls[Twitter]"], input[name*="Twitter"]',
        type: 'text',
      },
      currentCompany: {
        selector: 'input[name="org"], input[placeholder*="Current company"]',
        type: 'text',
      },
    },
    customQuestionSelectors: {
      textInput: '.application-additional input[type="text"]',
      textArea: '.application-additional textarea',
      select: '.application-additional select',
      checkbox: '.application-additional input[type="checkbox"]',
      radio: '.application-additional input[type="radio"]',
    },
    submitSelector:
      'button[type="submit"].postings-btn, button.postings-btn[data-qa="btn-submit"]',
    formContainerSelector: '.application-form, .posting-page',
    successIndicators: [
      'Application submitted',
      'Thank you for applying',
      'Your application has been submitted',
    ],
    notes:
      'Single-page form. Full name is one field (not split). Cover letter is a textarea, not file upload. URL fields are dynamically labeled (LinkedIn, GitHub, Portfolio, Other).',
  },

  ashby: {
    name: 'Ashby',
    detect: [/jobs\.ashbyhq\.com/, /app\.ashbyhq\.com/],
    applyUrl: (url) => {
      // Ashby application is on the same page, scrolls to form
      if (url.includes('/application')) return url;
      return url.replace(/\/?$/, '/application');
    },
    standardFields: {
      firstName: {
        selector:
          'input[name="firstName"], input[name="_systemfield_first_name"], input[data-testid="first-name-input"]',
        type: 'text',
      },
      lastName: {
        selector:
          'input[name="lastName"], input[name="_systemfield_last_name"], input[data-testid="last-name-input"]',
        type: 'text',
      },
      email: {
        selector:
          'input[name="email"], input[name="_systemfield_email"], input[type="email"]',
        type: 'text',
      },
      phone: {
        selector:
          'input[name="phone"], input[name="_systemfield_phone"], input[type="tel"]',
        type: 'text',
      },
      resume: {
        selector:
          'input[type="file"][name*="resume"], input[type="file"][data-testid="resume-input"]',
        type: 'file',
      },
      coverLetter: {
        selector:
          'input[type="file"][name*="coverLetter"], input[type="file"][data-testid="cover-letter-input"], textarea[name*="coverLetter"]',
        type: 'file',
        note: 'Some Ashby forms use file upload, others use textarea',
      },
      linkedin: {
        selector:
          'input[name*="linkedin"], input[name="_systemfield_linkedin"], input[placeholder*="LinkedIn"]',
        type: 'text',
      },
      website: {
        selector:
          'input[name*="website"], input[name*="portfolio"], input[placeholder*="Website"]',
        type: 'text',
      },
      github: {
        selector: 'input[name*="github"], input[placeholder*="GitHub"]',
        type: 'text',
      },
      location: {
        selector: 'input[name*="location"], input[name="_systemfield_location"]',
        type: 'text',
      },
      currentCompany: {
        selector: 'input[name*="currentCompany"], input[name="_systemfield_company"]',
        type: 'text',
      },
    },
    customQuestionSelectors: {
      textInput: '.ashby-application-form-field input[type="text"]',
      textArea: '.ashby-application-form-field textarea',
      select: '.ashby-application-form-field select',
      checkbox: '.ashby-application-form-field input[type="checkbox"]',
      radio: '.ashby-application-form-field input[type="radio"]',
    },
    submitSelector:
      'button[type="submit"], button[data-testid="submit-application"]',
    formContainerSelector:
      '.ashby-application-form, [data-testid="application-form"]',
    successIndicators: [
      'Thank you for applying',
      'Application received',
      'Successfully submitted',
      'Your application has been received',
    ],
    notes:
      'React-based SPA. Forms may lazy-load -- wait for form container to appear. Some companies use custom Ashby themes. System fields use _systemfield_ prefix. File uploads may require clicking a dropzone first.',
  },

  workday: {
    name: 'Workday',
    detect: [/\.myworkdayjobs\.com/, /\.wd\d+\.myworkdaysite\.com/, /workday\.com\/.*\/job/],
    applyUrl: null,
    standardFields: null,
    customQuestionSelectors: null,
    submitSelector: null,
    formContainerSelector: null,
    successIndicators: null,
    mode: 'assisted-manual',
    notes:
      'Complex multi-step wizard. Requires account creation. Dynamic AJAX forms with session tokens. Multiple pages (personal info, experience, education, self-identify). Use assisted-manual mode: read the form, generate answers for the user to paste, but do NOT attempt to automate submission. Claude should use browser_snapshot to read each step and provide copy-paste answers.',
  },

  icims: {
    name: 'iCIMS',
    detect: [/\.icims\.com/, /careers-.*\.icims\.com/],
    applyUrl: null,
    standardFields: null,
    customQuestionSelectors: null,
    submitSelector: null,
    formContainerSelector: null,
    successIndicators: null,
    mode: 'assisted-manual',
    notes:
      'Requires account creation and login. Multi-page forms with complex navigation. Heavy use of iframes. Use assisted-manual mode: read the form via screenshots, generate answers, let the user fill and submit. Claude should use browser_snapshot on each page.',
  },

  bamboohr: {
    name: 'BambooHR',
    detect: [/\.bamboohr\.com\/careers/, /\.bamboohr\.com\/jobs/],
    applyUrl: null,
    standardFields: null,
    mode: 'assisted-manual',
    notes:
      'Simpler forms but often embedded in iframes. Use assisted-manual mode for reliability.',
  },

  smartrecruiters: {
    name: 'SmartRecruiters',
    detect: [/jobs\.smartrecruiters\.com/],
    applyUrl: null,
    standardFields: null,
    mode: 'assisted-manual',
    notes:
      'Multi-step form with account creation option. Use assisted-manual mode.',
  },
};

/**
 * Detect ATS platform from a URL.
 * @param {string} url - The job posting or application URL
 * @returns {{ platform: string, config: object } | null}
 */
export function detectATS(url) {
  if (!url) return null;
  for (const [key, config] of Object.entries(platforms)) {
    if (config.detect && config.detect.some((re) => re.test(url))) {
      return { platform: key, config };
    }
  }
  return null;
}

/**
 * Check if a platform supports full automation.
 * @param {string} platformKey
 * @returns {boolean}
 */
export function isFullyAutomated(platformKey) {
  const p = platforms[platformKey];
  return p && !p.mode && p.standardFields !== null;
}

/**
 * Get field value from a profile.yml candidate object.
 * Maps ATS field names to profile data.
 *
 * @param {string} fieldName - ATS field name (e.g., 'firstName', 'email')
 * @param {object} profile - Parsed profile.yml candidate object
 * @returns {string|null}
 */
export function getFieldValue(fieldName, profile) {
  const c = profile.candidate || profile;

  const fullName = c.full_name || '';
  const nameParts = fullName.split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const map = {
    firstName,
    lastName,
    fullName: fullName,
    email: c.email || '',
    phone: c.phone || '',
    location: c.location || '',
    linkedin: c.linkedin ? `https://${c.linkedin.replace(/^https?:\/\//, '')}` : '',
    website: c.portfolio_url || '',
    github: c.github ? `https://${c.github.replace(/^https?:\/\//, '')}` : '',
    twitter: c.twitter ? `https://${c.twitter.replace(/^https?:\/\//, '')}` : '',
    currentCompany: '',
  };

  return map[fieldName] !== undefined ? map[fieldName] : null;
}

/**
 * Get the apply URL for a platform, transforming if needed.
 * @param {string} url - Original job URL
 * @param {string} platformKey
 * @returns {string}
 */
export function getApplyUrl(url, platformKey) {
  const p = platforms[platformKey];
  if (p && p.applyUrl && typeof p.applyUrl === 'function') {
    return p.applyUrl(url);
  }
  return url;
}

/**
 * List all supported platforms with their automation level.
 * @returns {Array<{ key: string, name: string, mode: string }>}
 */
export function listPlatforms() {
  return Object.entries(platforms).map(([key, config]) => ({
    key,
    name: config.name,
    mode: config.mode || 'fully-automated',
  }));
}
