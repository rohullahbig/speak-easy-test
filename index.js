// Dependencies
const express = require('express');
const bodyParser = require('body-parser');
const getRawBody = require('raw-body');
const cors = require('cors');
const crypto = require('crypto');
const dotenv = require('dotenv').config();
const axios = require('axios');
const multer = require('multer');
const storage = multer.memoryStorage(); 
const upload = multer({ storage: storage });

// App
const app = express();
const PORT = process.env.PORT || 3200;
const jsonParsser = bodyParser.urlencoded({ extended: false });

// Shopify
const shopifyAPI = require('shopify-node-api');
const SHOPIFY_SIGNATURE = process.env.SHOPIFY_SIGNATURE;
const API_KEY = process.env.API_KEY;
const API_PASS = process.env.API_PASS;
const latestVersion = '2023-04';
const Shopify = new shopifyAPI({
  shop: 'speakeasyhairextensions',
  shopify_api_key: API_KEY,
  access_token: API_PASS,
  verbose: false
})

// Salesforce
const jsforce = require('jsforce');
const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN, SF_CONSUMER_KEY, SF_CONSUMER_SECRET } = process.env;
const conn = new jsforce.Connection({
  loginUrl: SF_LOGIN_URL,
})

// AWS
const AWS = require('aws-sdk');
const AWS_ID = process.env.AWS_ID;
const AWS_SECRET = process.env.AWS_SECRET;
const HALO_BUCKET = process.env.HALO_BUCKET;
const s3 = new AWS.S3({
  accessKeyId: AWS_ID,
  secretAccessKey: AWS_SECRET
});

// Mailgun
const mg = require("mailgun-js");
const mailgun = mg({apiKey: process.env.mg_API_KEY, domain: 'mg.halocouture.com'});

// Middleware
app.use(cors({origin: 'https://halocouture.com'}));

// Functions 
function getContactID(name) {
  return new Promise((res,rej) => {
    conn.sobject("Account").find( {'Account.Name': name}, (err, data) => {
      if (err)  rej(err);
      if (data.length ) {
        for(i=0;i<data.length;i++) {
          if(data[i].Account_Brand__c == 'Halo') res(data[i].Id);
        }
      }
      res(null);
    });
  });
}

function createUploadPromise(imgFile) {
  const uniqueID = Date.now();
  const params = {
    ACL :'public-read',
    Body : imgFile.buffer,
    Bucket: HALO_BUCKET,
    ContentType: imgFile.mimetype,
    Key: `${uniqueID}-${imgFile.originalname}`
  }
  return s3.upload(params).promise();
}

function createImgUploadArray(images) {
  console.log('***Uplading image files...');
  let promises= [];

  for (i=0; i<images.length; i++) {
    var file = images[i];
    promises.push(createUploadPromise(file))
  }
  return promises;
}

// Routes 
app.post('/pos_order', async (req, res) => {

  // HMAC Shopify sends
  const hmac = req.get('X-Shopify-Hmac-Sha256');

  // Use raw-body to get the body (buffer)
  const body = await getRawBody(req);
  let order = JSON.parse(body.toString());

  // Create a hash (decrypting Shopify's HMAC)
  const hash = crypto
    .createHmac('sha256', SHOPIFY_SIGNATURE)
    .update(body, 'utf8', 'hex')
    .digest('base64')

  // Compare our hash to Shopify's HMAC
  if (hash === hmac) {
    res.status(200).send('OK');
    console.log('*=============== Webhook VERIFIED! ===============*');
    console.log('*=============== 📦 Order Created! ===============*');

    // Bounce if not POS order
    if ( order.source_name !== 'pos' ) return;

    // Customer vars
    let orderHasCustomer = order.customer ? true : false;
    let customer_id = orderHasCustomer ? order.customer.id : null;
    let existing_customer_tags = orderHasCustomer ? order.customer.tags : null;
    let customer_new_tags = '';
    let addStarterKitTag = false;
    let skusForStarterKitTag = ['Halo Starter Kit'];
    let addStylistTag = false;
    let skusForStylistTag = ["Color Ring Professional", "Halo Starter Kit"];
    let addIsAuthTag = false;
    let skusForIsAuthTag = ['Display with Hair 1','Display with Hair 2','Display with Hair 3','Display with Hair 4','Display with Hair 5'];
    let ordersCount;

    // Order vars
    let fulfillmentOrder_Id;
    let fulfillmentOrder_LineItemArr;
    let split_fulfillment = false;
    let orderId = order.id.toString();
    let line_items = order.line_items;
    let soldOutItem = false;
    let varID;
    let sku;
    
    // Fulfillment automation vars
    let tradeShowLocationID = 17187373122;
    let mainWarehouseLocationID = 17032052802;
    let inventoryItemId;
    let inventoryLevelsArr;
    
    console.log({Order_ID: order.id, Customer: orderHasCustomer ? customer_id : null});
    // console.log({Order: order});

     // Send account invite to new customer
     let sendAccountInvite = () => {
      return new Promise((res,rej)=> {
        let accountInvite = {
          "customer_invite": {}
        }
        Shopify.post(`/admin/api/${latestVersion}/customers/${customer_id}/send_invite.json`, accountInvite, (err, data)=> {
          if(err) rej(err);
          console.log({Status:"Account Invite Sent"});
          res();
        });
      });
    }

    // Adds tags to customer
    let addCustomerTags = (incoming_tags)=> {
      return new Promise((res,rej)=> {
        if(existing_customer_tags && existing_customer_tags !== '') var final_tags = existing_customer_tags += incoming_tags;
        else var final_tags = incoming_tags;
        
        let updatedCustomer = {
          "customer": {
            "id": customer_id,
            "tags": final_tags
          }
        }
        Shopify.put(`/admin/api/${latestVersion}/customers/${customer_id}.json`, updatedCustomer, async function(err, data) {
          if(err) rej(err);
          console.log({Status: "Trade Show Customer tags added"});
          res();
        });
      });
    }

    // Gets customer object in order to obtain orders_count
    let getCustomer = (email) => {
      return new Promise( (res, rej) => {
        Shopify.get(`/admin/customers/search.json?query=email:${email}`, async (err, data) => {
          if(err) rej(err);

          if (data.customers.length) res(data.customers[0]);
          else rej("EMAIL DOES NOT EXIST");          
        });
      });
    }

    // Changes Location on Fulfillment Order
    let changeFulfillmentOrderLocation = (locationID) => {
      return new Promise((res,rej)=> {
        let newFulfillmentOrder = {
          "fulfillment_order": {
            "id": fulfillmentOrder_Id,
            "new_location_id": locationID
          }
        }
        Shopify.post(`/admin/api/${latestVersion}/fulfillment_orders/${fulfillmentOrder_Id}/move.json`, newFulfillmentOrder, (err,data) => {
          if(err) rej(err);
          res();
        });
      });
    }

    // Gets the Fulfillment Order associated with the Order
    let getFulfillmentOrder = (orderID) => {
      return new Promise((res,rej)=> {
        Shopify.get(`/admin/api/${latestVersion}/orders/${orderID}/fulfillment_orders.json`, (err,data) => {
          if(err) rej(err);
          fulfillmentOrder_Id = data.fulfillment_orders[0].id;
          fulfillmentOrder_LineItemArr = data.fulfillment_orders[0].line_items;
          res();
        });
      });
    }

    // Fulfills line items 
    let fulfillItems = (post_data) => {
      return new Promise((res,rej)=> {
        Shopify.post(`/admin/api/${latestVersion}/fulfillments.json`, post_data, (err,data) => {
          if(err) rej(err);
          res();
        });
      });
    }

    // Get line item inventory id's 
    let getInventoryID = (varID) => {
      return new Promise((res,rej)=> {
        Shopify.get(`/admin/api/${latestVersion}/variants/${varID}.json`, (err,data)=> {
          if(err) rej(err);
          res(data.variant.inventory_item_id);
        });
      });
    }

    // Get line item inventory levels from location(s)
    let getInventoryLevels = (itemId, locationIds) => {
      return new Promise((res,rej)=> {
        Shopify.get(`/admin/api/${latestVersion}/inventory_levels.json?inventory_item_ids=${itemId}&location_ids=${locationIds}`, (err,data) => {
          if(err) rej(err)
          res(data.inventory_levels);
        });
      });
    }

    // Fulfill line items from Trade Show location
    let processFulfillments = (lineItemArr) => {
      return new Promise( async (res,rej)=> {
        // Holds all line items fulfilling at Trade Show
        let tradeShowItemsArr = [];

        // Iterates over Line Items from Fulfillment Order object
        for( i = 0; i < lineItemArr.length; i++ ) {
          // Customer tag logic based on products existing in cart
          sku = line_items[i].sku;
          if(skusForStarterKitTag.includes(sku)) addStarterKitTag = true;
          if(skusForStylistTag.includes(sku)) addStylistTag = true;
          if(skusForIsAuthTag.includes(sku)) addIsAuthTag = true;

          // Getting Inventory level of line item
          varID = line_items[i].variant_id;
          inventoryItemId = await getInventoryID(varID); // inventory id only used to obtain inventory levels
          inventoryLevelsArr = await getInventoryLevels(inventoryItemId, tradeShowLocationID);

          // Accounting for Shopify behavioral differences with inventory levels based on if shipping address provided
          if(order.shipping_address) var availableForPos = inventoryLevelsArr[0].available // Order does not deduct from current inventory level
          else var availableForPos = inventoryLevelsArr[0].available + lineItemArr[i].quantity; // adding back inventory that order deducted

          // Full quantity fulfillable from Trade Show Warehouse
          if( lineItemArr[i].quantity <= availableForPos ) {
            let itemObj = {
              "id": lineItemArr[i].id,
              "quantity": lineItemArr[i].quantity
            }
            tradeShowItemsArr.push(itemObj);
          }
          
          // Partial quantity fulfillable from Trade Show Warehouse
          if(availableForPos > 0 && availableForPos < lineItemArr[i].quantity) {
            split_fulfillment = true;
            // Quantity to fulfill from Trade Show Warehouse
            let itemObj = {
              "id": lineItemArr[i].id,
              "quantity": availableForPos
            }
            tradeShowItemsArr.push(itemObj);
          }

          // Keeps track if Order contains Sold Out items
          if(availableForPos == 0) soldOutItem = true; 
        }

        // Accounts for order containing Fulfillable and Sold Out items
        if(soldOutItem && tradeShowItemsArr.length) split_fulfillment = true;

        // Fulfillment Object
        let post_data = {
          "fulfillment": {
            "line_items_by_fulfillment_order": [
              {
                "fulfillment_order_id": fulfillmentOrder_Id,
                "fulfillment_order_line_items": tradeShowItemsArr
              }
            ]
          }
        }

        try{
          if(order.shipping_address && tradeShowItemsArr.length) await changeFulfillmentOrderLocation(tradeShowLocationID); // When shipping address is provided, order comes in set to Main Warehouse Location
          if(tradeShowItemsArr.length) await fulfillItems(post_data); // Only fires if there are items to fulfill at Trade Show
          if(order.shipping_address && split_fulfillment) await changeFulfillmentOrderLocation(mainWarehouseLocationID); // Switches remaining unfulfilled items back to Main Warehouse Location
          console.log({Status: 'Multi Location Fulfillment Success'});
          res();
        } catch (err) {
          console.log({Status: 'ERROR', Location: 'Fulfillment try/catch', Error: err});
        }
      });
    }

    // Process Begins
    try{
      await getFulfillmentOrder(orderId);
    } catch(err) {
      console.log({Status: 'ERROR', Location: 'Fulfillment Order try/catch', Error: err});
    }

    if(order.fulfillments.length == 0) { // prevents processing fulfillments for already fulfilled items in the event that POS setting is automatically fulfilling line items
      try{
        await processFulfillments(fulfillmentOrder_LineItemArr);
      } catch(err) {
        console.log({Status: 'ERROR', Location: 'processFulfillments() try/catch', Error: err});
      }
    }

    if(orderHasCustomer) {
      try {
        let customer = await getCustomer(order.customer.email);
        ordersCount = customer.orders_count;
      } catch(err) {
        console.log({Status: 'ERROR', Location: 'Get Customer try/catch', Error: err});
      }
  
      // Handles customer tags and sending Account Invite
      if(ordersCount == 1) customer_new_tags += ', 2023 IBS Las Vegas';
      if(addStarterKitTag) customer_new_tags += ', salon_starter_kit_purchased';
      if(addIsAuthTag) customer_new_tags += ', is-authorized';
      if(addStylistTag) customer_new_tags += ', Stylist';
  
      if((ordersCount == 1) || addStylistTag || addIsAuthTag) {
        try{
          await addCustomerTags(customer_new_tags);
        } catch(err) {
          console.log({Status: 'ERROR', Location: 'Add Customer Tags try/catch', Error: err});
        }
      }
  
      if(ordersCount == 1 && (addStylistTag || addIsAuthTag) && order.customer.state !== 'enabled') {
        try{
          await sendAccountInvite();
        } catch (err) {
          console.log({Status: 'ERROR', Location: 'Send Account Invite try/catch', Error: err});
        }
      }
    }
  } else {
    console.log('Danger! Not from Shopify!');
    res.sendStatus(403);
  }
});

app.post('/new-customer', jsonParsser, async (req,res) => {
  // console.log(req.body);

  let errorSent = false;
  let existing_SF_ID;
  let new_customer = {
    customer: {
      first_name: req.body.first_name,
      last_name: req.body.last_name,
      email: req.body.email,
      phone: req.body.mobile_phone,
      tags: req?.body?.tags ? 'Stylist ' + req?.body?.tags : 'Stylist',
      metafields: [
        {
          "namespace": "pro_form",
          "key": "Salon_Name",
          "value": req.body.salon_name,
          "type": "string"
        },
        {
          "namespace": "pro_form",
          "key": "Salon_Phone",
          "value": req.body.salon_phone,
          "type": "string"
        },
        {
          "namespace": "pro_form",
          "key": "Cosmetology_License_Num",
          "value": req.body.license_num,
          "type": "string"
        },
        {
          "namespace": "pro_form",
          "key": "State_Issued",
          "value": req.body.state_issued,
          "type": "string"
        },
        {
          "namespace": "pro_form",
          "key": "Professional_Type",
          "value": req.body.pro_type,
          "type": "string"
        },
        {
          "namespace": "pro_form",
          "key": "Interested_In",
          "value": req.body.interested_in,
          "type": "string"
        },
        {
          "namespace": "pro_form",
          "key": "Preferred_Contact_Method",
          "value": req.body.pref_contact_method,
          "type": "string"
        },
        {
          "namespace": "pro_form",
          "key": "Lead_Source",
          "value": req.body.lead_source,
          "type": "string"
        },
        {
          "namespace": "pro_form",
          "key": "Who_Inspired_You",
          "value": req.body.referral,
          "type": "string"
        },
        {
          "namespace": "pro_form",
          "key": "Message",
          "value": req.body.message,
          "type": "string"
        }
      ],
      addresses: [
        {
          zip: req.body.zip
        },
      ],
      accepts_marketing: true,
      password: req.body.password,
      password_confirmation: req.body.password,
      send_email_invite: false,
      send_email_welcome: true
    }
  };
  let sf_lead = { 
    Brand__c: 'a008a00000ydIKPAA2', 
    LeadSource: 'Web',
    firstName: req.body.first_name,
    lastName: req.body.last_name,
    Email: req.body.email,
    MobilePhone: req.body.mobile_phone,
    Shopify_Tags__c: req.body.tags,
    Company: req.body.salon_name,
    Salon_Phone__c: req.body.salon_phone,
    Preferred_Contact_Method__c: req.body.pref_contact_method,
    Cosmetology_License_Number__c: req.body.license_num,
    Cosmetology_License_Issued_State__c: req.body.state_issued,
    Halo_Contact_Type__c: req.body.pro_type,
    Halo_Interested_In__c: req.body.interested_in,
    Halo_How_did_you_hear_about_us__c: req.body.lead_source,
    Halo_Message__c: req.body.message,
    Halo_Who_inspired_you_to_visit_us__c: req.body.referral,
    Agreed_to_Account_Terms__c: true, // front end only makes post if this is true
    HasOptedOutOfEmail: false, // part of terms
    et4ae5__HasOptedOutOfMobile__c: false // part of terms
  }

  let createCustomer = (customer) => {
    return new Promise((res,rej) => {
      Shopify.post(`/admin/api/${latestVersion}/customers.json`, customer, (err, data)=> {
        if(data.errors) rej(data);
        if(data.customer) res(data.customer.id);
      });
    });
  }

  let find_SF_Lead = () => {
    return new Promise((res,rej)=> {
      conn.sobject("Lead").find({Email: req.body.email}).execute((err, records) => {
        if(err) rej(err);
        // console.log(records);
        if(records.length && records[0].Brand__c == 'a008a00000ydIKPAA2') res(records[0].Id);
        if(!records.length || records[0].Brand__c !== 'a008a00000ydIKPAA2') res(false);
      });
    });
  }

  let update_SF_Lead = (lead)=> {
    return new Promise((res,rej)=> {
      conn.sobject("Lead").update(lead, (err, ret) => {
        if (err || !ret.success) rej(err, ret);
        res();
      });
    });
  }

  let create_SF_Lead = (lead) => {
    return new Promise((res,rej)=> { 
      conn.sobject("Lead").create(lead, (err, ret) => {
        if (err || !ret.success)  rej(err);
        res();
      });
    });
  }
  
  try {
    var ShopifyID = await createCustomer(new_customer);
    sf_lead.Shopify_ID__c = ShopifyID;
  } catch(err) {
    let errorArr = [];
    if(err.errors.email) errorArr.push({email_error: 'Email has already been taken.'});
    if(err.errors.phone) errorArr.push({phone_error: 'Phone has already been taken.'});
    errorSent = true
    res.status(200).send({errors: errorArr});
  }

  
  conn.login(SF_USERNAME, SF_PASSWORD + SF_TOKEN, async (err, data) => {
    if(err) return console.error(err);
    
    try {
      existing_SF_ID = await find_SF_Lead();
      if(existing_SF_ID) {
        sf_lead.Id = existing_SF_ID;
        await update_SF_Lead(sf_lead);
      } else {
        await create_SF_Lead(sf_lead);
      }
    } catch(err) {
      console.log(err);
    }
  })

  if(!errorSent) res.status(200).send('success');
});

app.post('/contact-us', jsonParsser, async (req,res) => {
  let data = JSON.parse(JSON.stringify(req.body));
  // console.log({Event: '/contact-us Submission', Data: data});

  conn.login(SF_USERNAME, SF_PASSWORD+SF_TOKEN, async (err, data) => {
    if(err) return console.error(err);

    try {
      var accountId = await getContactID(req.body.name);
    } catch(err) {
      console.log(err)
    }

    let sf_case = {
      Brand__c: 'a008a00000ydIKPAA2',
      Case_Brand__c: 'Halo',
      Origin: 'Web',
      SuppliedName: req.body.name,
      SuppliedEmail: req.body.email,
      SuppliedPhone: req.body.phone,
      Subject: req.body.subject,
      Description: req.body.description
    }

    accountId ? sf_case.AccountId = accountId : null;

    conn.sobject("Case").create( sf_case, (err, ret) => {
      if (err || !ret.success)  return console.error(err, ret);
      console.log({Status: 'Salesforce Case Created', Data: ret});
    });
  });

  res.status(200).json('success');
});

app.post('/sub-popup', jsonParsser, async (req,res) => {
  let data = JSON.parse(JSON.stringify(req.body));
  console.log({Event: '/sub-popup Submission', Data: data});
  let subID;

  let emailCheck = (email) => {
    return new Promise((res,rej) => {
      Shopify.get(`/admin/customers/search.json?query=email:${email}`, (err, data) => {
        if(err) rej(err.error);
        
        if(data.customers.length) {
          subID = data.customers[0].id;
          subTags = data.customers[0].tags;
          res(true);
        } else {
          res(false);
        }
      });
    });
  }

  let createSub = (sub) => {
    return new Promise((res,rej) => {
      Shopify.post(`/admin/api/${latestVersion}/customers.json`,sub, (err, data)=> {
        if(err) rej(err);

        res(data);
      });
    });
  }

  let updateSub = (sub) => {
    return new Promise((res,rej) => {
      Shopify.put(`/admin/api/${latestVersion}/customers/${subID}.json`, sub, async function(err, data) {
        if(err) rej(err);

        res();
      });
    });
  }

  try {
    var existing_customer = await emailCheck(req.body.email);
  } catch(err) {
    console.error(err);
  }


  if(existing_customer) {
    let sub = {
      customer: {
        accepts_marketing: true,
        tags: subTags + `,${req.body.proType}`,
        phone: req.body.phone ? req.body.phone : null
      }
    }
    try {
      await updateSub(sub);
    } catch(err) {
      console.error(err);
    }
  } else {
    let sub = {
      customer: {
        email: req.body.email,
        tags: req.body.proType,
        accepts_marketing: true,
        phone: req.body.phone ? req.body.phone : null
      }
    }
    try {
      let newSub = await createSub(sub);
      subID = newSub.customer.id;
    } catch(err) {
      console.error(err);
    }
  }

  if(req.body.phone) {
    let sub = {
      customer: {
        sms_marketing_consent: {
          state: 'subscribed',
          opt_in_level: "single_opt_in",
        }
      }
    }
    try {
      await updateSub(sub);
    } catch(err) {
      console.error(err);
    }
  }
  
  res.status(200).json('success');
})

app.post('/photo-submission',jsonParsser, upload.fields([{name:'img_1'},{name:'img_2'}]), async (req,res) => {
  let data = JSON.parse(JSON.stringify(req.body));
  // console.log({Event: '/photo-submission Submission', Data: data});
  
  let imgFiles = [];
  let img_1 = req.files.img_1[0];
  let img_2 = req.files.img_2[0];
  imgFiles = [img_1, img_2];

  const imgUploads = createImgUploadArray(imgFiles); // returns the array of promises
  
  try {
    const data = await Promise.all(imgUploads);
    var img_1_url = data[0].Location;
    var img_2_url = data[1].Location;
    console.log({
      Status:'Image file uploaded successfully',
      File_links: {
        Img_1_Link: data[0].Location,
        Img_2_Link: data[1].Location
      }
    });
  } catch(err) {
    console.error({Status: 'ERROR', Location: '/photo-submission', Error: err});
  }

  let internalComments = `
    City: ${req.body.city},
    State: ${req.body.state},
    Zip: ${req.body.zip},
    Interested In: ${req.body.prod_interest},
    Best Contact Method: ${req.body.best_com},
    Image (Front): ${img_1_url},
    Image (Back): ${img_2_url},
    Message: ${req.body.message}
  `;

  conn.login(SF_USERNAME, SF_PASSWORD+SF_TOKEN, async (err, data) => {
    if(err) return console.error(err);

    try {
      var accountId = await getContactID(`${req.body.firstName} ${req.body.lastName}`);
    } catch(err) {
      console.error(err)
    }

    let sf_case = {
      Brand__c: 'a008a00000ydIKPAA2',
      Case_Brand__c: 'Halo',
      Origin: 'Web',
      SuppliedName: `${req.body.firstName} ${req.body.lastName}`,
      SuppliedEmail: req.body.email,
      SuppliedPhone: req.body.phone,
      Description: internalComments,
      // Comments: internalComments
    }

    if(accountId) sf_case.AccountId = accountId;

    conn.sobject("Case").create( sf_case, (err, ret) => {
      if (err || !ret.success)  return console.error(err, ret);
      console.log({Status: 'Salesforce Case Created', Data: ret});
    });
  });

  res.status(200).json('success');
})

app.post('/salon-locator-registration', jsonParsser, async (req,res) => {
  res.status(200).json('success');
  let lead = JSON.parse(JSON.stringify(req.body));

  var internalComments = `
    Street Address: ${lead.address},
    City: ${lead.city},
    State: ${lead.state},
    Zip: ${lead.zip},
    Website URL: ${lead.site_url ? lead.site_url: 'N/A'},
    Facebook URL: ${lead.fb_url ? lead.fb_url: 'N/A'},
    Instagram Handle: ${lead.insta_url ? lead.insta_url: 'N/A'},
    Booking URL: ${lead.booking_url ? lead.booking_url: 'N/A'}
  `;

  conn.login(SF_USERNAME, SF_PASSWORD+SF_TOKEN, async (err, data) => {
    if(err) return console.error(err);

    if(lead.contact_name) {
      try {
        var accountId = await getContactID(`${lead.contact_name}`);
      } catch(err) {
        console.error(err)
      }
    }

    let sf_case = {
      Brand__c: 'a008a00000ydIKPAA2',
      Case_Brand__c: 'Halo',
      Origin: 'Web',
      Reason: 'Salon Locator',
      SuppliedCompany: lead.salon_name,
      SuppliedName: lead.contact_name ? lead.contact_name : '',
      SuppliedEmail: lead.email,
      SuppliedPhone: lead.phone,
      Subject: 'Salon Locator Registration',
      Description: internalComments,
      // Comments: internalComments, // Not set up in Salesforce
    }

    if(accountId) sf_case.AccountId = accountId;

    conn.sobject("Case").create( sf_case, (err, ret) => {
      if (err || !ret.success)  return console.error(err, ret);
      console.log({Status: 'Salesforce Case Created', Data: ret});
    });
  });

});

app.listen(PORT, () => console.log(`App listening on port ${PORT}!`));